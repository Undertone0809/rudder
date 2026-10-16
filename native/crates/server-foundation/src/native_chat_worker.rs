//! Process-owned execution of already admitted Native Chat attempts.
//!
//! This is an in-process Rust API, not an HTTP admission/Stop API. Jobs are not
//! reconstructed on restart. A commit-to-dispatch crash leaves the admitted
//! attempt unresolved; durable admission exclusion still prevents a fresh turn.
//! Claimed attempts retain their hold until a separate authority resolves them.
use futures_util::FutureExt;
use rudder_auth_core::VerifiedActor;
use rudder_d1_persistence::native_chat::{config::LocalHostContext, execution};
use rudder_native_chat_executor::{ExecutionRequest, HostPaths};
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, watch},
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
    actor: VerifiedActor,
    host: LocalHostContext,
    paths: HostPaths,
    key: Key,
    timeout: Duration,
}

impl Job {
    pub fn new(
        actor: VerifiedActor,
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

    /// A duplicate start never returns a cached observation capability. Both
    /// duplicates and capacity exhaustion have the same non-revealing failure.
    /// Claim authorization still happens in D1 for every newly started worker.
    pub fn try_start(&self, job: Job) -> Result<Ticket, StartError> {
        let key = job.key.clone();
        let pool = self.0.pool.clone();
        let handle = tokio::runtime::Handle::current();
        self.start(key, move |cancelled| run(&handle, pool, job, cancelled))
    }

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
        if state.jobs.len() >= MAX_RETAINED {
            let finished = state.jobs.iter().find_map(|(key, entry)| {
                (entry.task.is_none() && entry.slot.is_none()).then(|| key.clone())
            });
            if let Some(key) = finished {
                state.jobs.remove(&key);
            } else {
                return Err(StartError::Busy);
            }
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
                if state.jobs.values().all(|entry| entry.slot.is_none()) {
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

struct Completion {
    status: Status,
    quiescent: bool,
}

fn reap(state: &mut State) {
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
    let observation = rudder_native_chat_executor::run_observed_on_blocking_thread(
        handle,
        &pool,
        &job.actor,
        &job.host,
        &job.paths,
        ExecutionRequest {
            organization_id: &job.key.organization_id,
            run_id: &job.key.run_id,
            attempt_id: &job.key.attempt_id,
            timeout: job.timeout,
            cancelled: &cancelled,
        },
    );
    let observation = match observation {
        Ok(observation) => observation,
        Err(failure) => {
            return Completion {
                status: Status::Unresolved(UnresolvedReason::ExecutionUnresolved),
                quiescent: failure.process_disposition()
                    != rudder_native_chat_executor::ProcessDisposition::Unresolved,
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
        match tokio::time::timeout(
            Duration::from_secs(5),
            execution::finalize(
                &pool,
                &job.actor,
                &observation.fence,
                &observation.turn_receipt,
                &cleanup,
            ),
        )
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
