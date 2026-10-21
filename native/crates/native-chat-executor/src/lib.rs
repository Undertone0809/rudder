//! Private, single-owner Codex turn execution. No public HTTP activation or Run
//! finalization authority lives here. Every exit retains the admission hold;
//! provider terminal data and host receipts require a separate finalizer.
mod claude;
mod cursor;
mod hermes;
mod opencode;
mod pi;
mod profile;
mod wire;
pub use claude::{
    ClaudeExecutionError, ClaudeExecutionObservation, execute_turn as execute_claude_turn,
};
pub use cursor::{
    CursorExecutionError, CursorExecutionObservation, execute_turn as execute_cursor_turn,
};
pub use opencode::{
    OpenCodeExecutionError, OpenCodeExecutionObservation, execute_turn as execute_opencode_turn,
};
pub use pi::{
    PiAdapterError, PiExecution, PiExecutionObservation, PiExecutionPhase, PiStateSnapshot,
    PiUnknownReason,
};
pub use profile::provision_profile;

use crate::wire::ProviderTerminal;
use rudder_auth_core::VerifiedActor;
use rudder_codex_app_server::{
    CleanupReceipt, EffectResponseReceipt, Message, OwnedTransport, ProcessLaunch, RequestId,
    SessionObservation, TransportError, TransportEvent, TurnReceipt,
};
use rudder_d1_persistence::{
    native_chat::{
        NativeChatActor, NativeChatExecutionPrincipal,
        config::{LocalHostContext, ResolvedCodexConfig},
        execution::{
            self, CheckpointSnapshot, CheckpointTransition, EffectDispatch, ExecutionFence,
        },
    },
    runtime_bindings,
};
use rudder_hermes_acp::{HermesCleanupReceipt, HermesTransportError, HermesTurnReceipt};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, VecDeque},
    fmt,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::runtime::Handle;

type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Native Chat blocking worker was interrupted")]
    WorkerInterrupted,
    #[error("Native Chat durable authority rejected execution")]
    Persistence(#[source] runtime_bindings::Error),
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error(transparent)]
    HermesTransport(#[from] HermesTransportError),
    #[error(transparent)]
    PiTransport(#[from] PiAdapterError),
    #[error(transparent)]
    ClaudeTransport(#[from] ClaudeExecutionError),
    #[error(transparent)]
    CursorTransport(#[from] CursorExecutionError),
    #[error("OpenCode execution failed: {0}")]
    OpenCodeExecution(String),
    #[error("Native Chat operation deadline expired; reconcile the held attempt")]
    Deadline,
    #[error("Native Chat execution was cancelled; reconcile the held attempt")]
    Cancelled,
    #[error("Native Chat runtime configuration has not been isolated")]
    UnsupportedConfiguration,
    #[error("Native Chat received an invalid or mismatched provider observation")]
    InvalidProviderObservation,
    #[error("Native Chat requires a governed provider decision")]
    ApprovalRequired,
    #[error("Native Chat provider rejected the request; input must not be retried")]
    ProviderRejected,
    #[error("Native Chat process exited before a matching provider terminal observation")]
    ProcessExited,
}

/// Installation paths, never accepted from an HTTP request. The isolated HOME
/// must be provisioned by the Rust host; this executor does not copy credentials
/// or use the operator's ambient environment.
#[derive(Clone)]
pub struct HostPaths {
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub isolated_home: PathBuf,
}

/// All IDs refer to an already admitted Run/Attempt. No prompt or client-selected
/// runtime configuration is accepted here.
pub struct ExecutionRequest<'a> {
    pub organization_id: &'a str,
    pub run_id: &'a str,
    pub attempt_id: &'a str,
    pub timeout: Duration,
    pub cancelled: &'a AtomicBool,
}

pub struct OwnedExecutionRequest {
    pub organization_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub timeout: Duration,
    pub cancelled: Arc<AtomicBool>,
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Own all worker inputs; dropping this future requests cancellation even while
/// the blocking worker is awaiting a database round trip. It still must reap
/// its own process and cannot release the held Run as a cancellation shortcut.
pub async fn execute(
    pool: PgPool,
    actor: VerifiedActor,
    host: LocalHostContext,
    paths: HostPaths,
    request: OwnedExecutionRequest,
) -> Result<ExecutionObservation> {
    let _cancel_on_drop = CancelOnDrop(Arc::clone(&request.cancelled));
    let handle = Handle::current();
    tokio::task::spawn_blocking(move || {
        run_observed_with_request_actor_on_blocking_thread(
            &handle,
            &pool,
            actor,
            &host,
            &paths,
            ExecutionRequest {
                organization_id: &request.organization_id,
                run_id: &request.run_id,
                attempt_id: &request.attempt_id,
                timeout: request.timeout,
                cancelled: &request.cancelled,
            },
        )
    })
    .await
    .map_err(|_| Error::WorkerInterrupted)?
    .map_err(ExecutionFailure::into_error)
}

/// Observation only: even cleanup_proven=true does not release the durable hold
/// or finish the Run. The finalizer must validate/persist projection and billing.
pub struct ExecutionObservation {
    /// Move-only identity minted by the successful D1 claim. Finalizers must
    /// use this value, never the request actor that initiated admission.
    pub execution_principal: NativeChatExecutionPrincipal,
    pub fence: ExecutionFence,
    pub turn_receipt: TurnReceipt,
    pub cleanup_receipt: Option<CleanupReceipt>,
    /// Compatibility observation only. Finalization must use the opaque receipt.
    pub cleanup_proven: bool,
    pub stop: Option<execution::StopIntent>,
}

/// Closed provider result returned to the Foundation owner. Provider-specific
/// identifiers remain in their typed receipt and are never projected as
/// Codex Thread/Turn IDs.
pub enum NativeExecutionObservation {
    Codex(ExecutionObservation),
    Hermes(HermesExecutionObservation),
    /// Pi keeps its own session-tree identities and receipt shape. The shared
    /// worker must consume this typed envelope instead of routing it through
    /// the Codex Thread/Turn finalizer. The current D1 finalizer does not yet
    /// have a Pi projection, so Foundation reports the observation as an
    /// explicit unresolved state until that boundary is added.
    Pi(PiNativeExecutionObservation),
    /// Claude Code owns stream-json session and result identities.
    Claude(ClaudeNativeExecutionObservation),
    /// Cursor ACP owns JSON-RPC session identity and update observations.
    Cursor(CursorNativeExecutionObservation),
    /// OpenCode owns Server Session and assistant message identities.
    OpenCode(OpenCodeNativeExecutionObservation),
}

/// Claude provider receipt paired with the D1 claim fence.
pub struct ClaudeNativeExecutionObservation {
    pub execution_principal: NativeChatExecutionPrincipal,
    pub fence: ExecutionFence,
    pub observation: ClaudeExecutionObservation,
}

/// Cursor provider receipt paired with the D1 claim fence.
pub struct CursorNativeExecutionObservation {
    pub execution_principal: NativeChatExecutionPrincipal,
    pub fence: ExecutionFence,
    pub observation: CursorExecutionObservation,
}

/// OpenCode provider receipt paired with the D1 claim fence. OpenCode Server
/// is host-owned separately, so its cleanup status remains provider-native.
pub struct OpenCodeNativeExecutionObservation {
    pub execution_principal: NativeChatExecutionPrincipal,
    pub fence: ExecutionFence,
    pub observation: OpenCodeExecutionObservation,
}

pub struct HermesExecutionObservation {
    pub execution_principal: NativeChatExecutionPrincipal,
    pub fence: ExecutionFence,
    pub turn_receipt: HermesTurnReceipt,
    pub cleanup_receipt: Option<HermesCleanupReceipt>,
    pub stop: Option<execution::StopIntent>,
}

/// Provider-specific Pi observation paired with the exact D1 execution fence
/// that admitted it. Pi session ids and leaf ids remain opaque provider data;
/// this wrapper intentionally has no Codex thread/turn fields.
pub struct PiNativeExecutionObservation {
    pub execution_principal: NativeChatExecutionPrincipal,
    pub fence: ExecutionFence,
    pub observation: PiExecutionObservation,
}

fn db<T>(
    handle: &Handle,
    deadline: Instant,
    future: impl Future<Output = std::result::Result<T, runtime_bindings::Error>>,
) -> Result<T> {
    handle.block_on(async {
        tokio::time::timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(5)),
            future,
        )
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(Error::Persistence)
    })
}

/// Process containment only; none of these facts establishes the durable Run
/// outcome, whether a claim committed, or permission to replay an attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessDisposition {
    NotLaunched,
    CleanupProven,
    Unresolved,
}

/// Opaque failure evidence, constructed only by the executor that owns launch
/// and observes cleanup. It cannot be used to finalize a provider turn.
pub struct ExecutionFailure(Box<ExecutionFailureEvidence>);

struct ExecutionFailureEvidence {
    error: Error,
    process: ProcessDisposition,
    fence: Option<ExecutionFence>,
    execution_principal: Option<NativeChatExecutionPrincipal>,
    cleanup_receipt: Option<CleanupReceipt>,
    hermes_cleanup_receipt: Option<HermesCleanupReceipt>,
    pi_cleanup_receipt: Option<rudder_pi_rpc::PiCleanupReceipt>,
}

impl fmt::Debug for ExecutionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionFailure")
            .field("error", &self.0.error)
            .field("process", &self.0.process)
            .field("hasFence", &self.0.fence.is_some())
            .field(
                "hasExecutionPrincipal",
                &self.0.execution_principal.is_some(),
            )
            .field("hasCleanupReceipt", &self.0.cleanup_receipt.is_some())
            .field(
                "hasHermesCleanupReceipt",
                &self.0.hermes_cleanup_receipt.is_some(),
            )
            .field("hasPiCleanupReceipt", &self.0.pi_cleanup_receipt.is_some())
            .finish()
    }
}

impl ExecutionFailure {
    /// Bounded diagnostic classification. Never expose provider payloads,
    /// environment values, filesystem paths or durable owner capabilities.
    pub fn diagnostic_code(&self) -> &'static str {
        match &self.0.error {
            Error::Transport(TransportError::OutputOverflow) => "codex_output_queue_full",
            Error::Transport(TransportError::InvalidTurnReceipt) => "codex_invalid_turn_receipt",
            Error::Transport(_) => "codex_transport",
            Error::Persistence(runtime_bindings::Error::Http(409, _)) => "persistence_conflict",
            Error::Persistence(_) => "persistence",
            Error::WorkerInterrupted => "worker_interrupted",
            Error::HermesTransport(_) => "hermes_transport",
            Error::PiTransport(_) => "pi_transport",
            Error::ClaudeTransport(_) => "claude_transport",
            Error::CursorTransport(_) => "cursor_transport",
            Error::OpenCodeExecution(_) => "opencode_execution",
            Error::Deadline => "deadline",
            Error::Cancelled => "cancelled",
            Error::UnsupportedConfiguration => "unsupported_configuration",
            Error::InvalidProviderObservation => "invalid_provider_observation",
            Error::ApprovalRequired => "approval_required",
            Error::ProviderRejected => "provider_rejected",
            Error::ProcessExited => "process_exited",
        }
    }

    pub fn process_disposition(&self) -> ProcessDisposition {
        self.0.process
    }
    /// True only when no child was launched or this exact claim's owned
    /// transport supplied matching terminal cleanup evidence.
    pub fn process_quiescent(&self) -> bool {
        self.0.process != ProcessDisposition::Unresolved
    }
    /// Private in-process continuation evidence; absence of a fence is expected
    /// for failures before the durable claim returned.
    pub fn fence(&self) -> Option<&ExecutionFence> {
        self.0.fence.as_ref()
    }
    /// Available only after a successful durable claim. A missing principal
    /// means the request never crossed into execution authority.
    pub fn execution_principal(&self) -> Option<&NativeChatExecutionPrincipal> {
        self.0.execution_principal.as_ref()
    }
    /// Actual owned-transport cleanup proof, never inferred from the enum above.
    pub fn cleanup_receipt(&self) -> Option<&CleanupReceipt> {
        self.0.cleanup_receipt.as_ref()
    }
    pub fn hermes_cleanup_receipt(&self) -> Option<&HermesCleanupReceipt> {
        self.0.hermes_cleanup_receipt.as_ref()
    }
    pub fn pi_cleanup_receipt(&self) -> Option<&rudder_pi_rpc::PiCleanupReceipt> {
        self.0.pi_cleanup_receipt.as_ref()
    }
    pub fn into_error(self) -> Error {
        self.0.error
    }

    /// Cancellation means the caller abandoned execution without a provider
    /// terminal receipt; cleanup alone must not release the durable hold.
    pub fn is_cancelled(&self) -> bool {
        matches!(&self.0.error, Error::Cancelled)
    }

    /// Only failures that prove the provider rejected or could not accept the
    /// request before any provider effect may release the durable hold. All
    /// transport, approval, deadline, and observation failures remain
    /// indeterminate until a governed reconciliation path resolves them.
    pub fn is_definitive_failure(&self) -> bool {
        matches!(
            &self.0.error,
            Error::ProviderRejected | Error::UnsupportedConfiguration
        )
    }

    fn not_launched(error: Error) -> Self {
        Self(Box::new(ExecutionFailureEvidence {
            error,
            process: ProcessDisposition::NotLaunched,
            fence: None,
            execution_principal: None,
            cleanup_receipt: None,
            hermes_cleanup_receipt: None,
            pi_cleanup_receipt: None,
        }))
    }

    fn before_launch(
        error: Error,
        execution_principal: NativeChatExecutionPrincipal,
        fence: ExecutionFence,
    ) -> Self {
        Self(Box::new(ExecutionFailureEvidence {
            error,
            process: ProcessDisposition::NotLaunched,
            fence: Some(fence),
            execution_principal: Some(execution_principal),
            cleanup_receipt: None,
            hermes_cleanup_receipt: None,
            pi_cleanup_receipt: None,
        }))
    }

    fn after_claim(
        error: Error,
        execution_principal: NativeChatExecutionPrincipal,
        fence: ExecutionFence,
        cleanup_receipt: Option<CleanupReceipt>,
    ) -> Self {
        let cleanup_receipt =
            cleanup_receipt.filter(|cleanup| cleanup_proves_owned_execution(&fence, cleanup));
        let process = if cleanup_receipt.is_some() {
            ProcessDisposition::CleanupProven
        } else {
            ProcessDisposition::Unresolved
        };
        Self(Box::new(ExecutionFailureEvidence {
            error,
            process,
            fence: Some(fence),
            execution_principal: Some(execution_principal),
            cleanup_receipt,
            hermes_cleanup_receipt: None,
            pi_cleanup_receipt: None,
        }))
    }

    fn after_claim_hermes(
        error: Error,
        execution_principal: NativeChatExecutionPrincipal,
        fence: ExecutionFence,
        cleanup_receipt: Option<HermesCleanupReceipt>,
    ) -> Self {
        let cleanup_receipt =
            cleanup_receipt.filter(|cleanup| fence.matches_hermes_cleanup_receipt(cleanup));
        let process = if cleanup_receipt.is_some() {
            ProcessDisposition::CleanupProven
        } else {
            ProcessDisposition::Unresolved
        };
        Self(Box::new(ExecutionFailureEvidence {
            error,
            process,
            fence: Some(fence),
            execution_principal: Some(execution_principal),
            cleanup_receipt: None,
            hermes_cleanup_receipt: cleanup_receipt,
            pi_cleanup_receipt: None,
        }))
    }

    fn after_claim_pi(
        error: Error,
        execution_principal: NativeChatExecutionPrincipal,
        fence: ExecutionFence,
        cleanup_receipt: Option<rudder_pi_rpc::PiCleanupReceipt>,
    ) -> Self {
        let cleanup_receipt =
            cleanup_receipt.filter(|cleanup| fence.matches_pi_cleanup_receipt(cleanup));
        let process = if cleanup_receipt.is_some() {
            ProcessDisposition::CleanupProven
        } else {
            ProcessDisposition::Unresolved
        };
        Self(Box::new(ExecutionFailureEvidence {
            error,
            process,
            fence: Some(fence),
            execution_principal: Some(execution_principal),
            cleanup_receipt: None,
            hermes_cleanup_receipt: None,
            pi_cleanup_receipt: cleanup_receipt,
        }))
    }

    #[cfg(all(test, unix))]
    fn after_launch(
        error: Error,
        fence: ExecutionFence,
        cleanup_receipt: Option<CleanupReceipt>,
    ) -> Self {
        let cleanup_receipt =
            cleanup_receipt.filter(|cleanup| cleanup_proves_owned_execution(&fence, cleanup));
        let process = if cleanup_receipt.is_some() {
            ProcessDisposition::CleanupProven
        } else {
            ProcessDisposition::Unresolved
        };
        Self(Box::new(ExecutionFailureEvidence {
            error,
            process,
            fence: Some(fence),
            execution_principal: None,
            cleanup_receipt,
            hermes_cleanup_receipt: None,
            pi_cleanup_receipt: None,
        }))
    }
}

fn cleanup_proves_owned_execution(fence: &ExecutionFence, cleanup: &CleanupReceipt) -> bool {
    fence.matches_cleanup_receipt(cleanup)
}

/// Run only on a dedicated blocking worker (e.g. spawn_blocking), with the
/// caller's Tokio runtime kept alive. Transport polling and Drop are blocking.
/// Cancellation is explicit: abandoning a task handle alone is not a stop.
pub fn run_on_blocking_thread(
    handle: &Handle,
    pool: &PgPool,
    actor: &VerifiedActor,
    host: &LocalHostContext,
    paths: &HostPaths,
    request: ExecutionRequest<'_>,
) -> Result<ExecutionObservation> {
    run_observed_on_blocking_thread(handle, pool, actor, host, paths, request)
        .map_err(ExecutionFailure::into_error)
}

/// Dedicated blocking worker variant retaining process-containment evidence on
/// failure. A NotLaunched observation does not prove a database commit failed.
pub fn run_observed_on_blocking_thread(
    handle: &Handle,
    pool: &PgPool,
    actor: &VerifiedActor,
    host: &LocalHostContext,
    paths: &HostPaths,
    request: ExecutionRequest<'_>,
) -> std::result::Result<ExecutionObservation, ExecutionFailure> {
    run_observed_with_request_actor_on_blocking_thread(
        handle,
        pool,
        actor.clone(),
        host,
        paths,
        request,
    )
}

/// Owned request-actor entrypoint used by Foundation jobs. Keeping the actor
/// owned here lets the executor drop request-scoped browser credentials as
/// soon as the D1 claim returns its sealed continuation principal.
pub fn run_observed_with_request_actor_on_blocking_thread<A>(
    handle: &Handle,
    pool: &PgPool,
    actor: A,
    host: &LocalHostContext,
    paths: &HostPaths,
    request: ExecutionRequest<'_>,
) -> std::result::Result<ExecutionObservation, ExecutionFailure>
where
    A: NativeChatActor,
{
    match run_observed_native_with_request_actor_on_blocking_thread_impl(
        handle, pool, actor, host, paths, request, false,
    )? {
        NativeExecutionObservation::Codex(observation) => Ok(observation),
        NativeExecutionObservation::Hermes(_)
        | NativeExecutionObservation::Pi(_)
        | NativeExecutionObservation::Claude(_)
        | NativeExecutionObservation::Cursor(_)
        | NativeExecutionObservation::OpenCode(_) => Err(ExecutionFailure::not_launched(
            Error::UnsupportedConfiguration,
        )),
    }
}

/// Provider-discriminated entrypoint for the trusted Foundation worker. The
/// durable selected Agent runtime chooses the branch; HTTP cannot select it.
pub fn run_observed_native_with_request_actor_on_blocking_thread<A>(
    handle: &Handle,
    pool: &PgPool,
    actor: A,
    host: &LocalHostContext,
    paths: &HostPaths,
    request: ExecutionRequest<'_>,
) -> std::result::Result<NativeExecutionObservation, ExecutionFailure>
where
    A: NativeChatActor,
{
    run_observed_native_with_request_actor_on_blocking_thread_impl(
        handle, pool, actor, host, paths, request, true,
    )
}

fn run_observed_native_with_request_actor_on_blocking_thread_impl<A>(
    handle: &Handle,
    pool: &PgPool,
    actor: A,
    host: &LocalHostContext,
    paths: &HostPaths,
    request: ExecutionRequest<'_>,
    allow_hermes: bool,
) -> std::result::Result<NativeExecutionObservation, ExecutionFailure>
where
    A: NativeChatActor,
{
    if request.timeout.is_zero()
        || request.timeout > Duration::from_secs(3600)
        || request.cancelled.load(Ordering::Acquire)
    {
        return Err(ExecutionFailure::not_launched(Error::Cancelled));
    }
    let deadline = Instant::now() + request.timeout;
    if let Err(error) = validate_paths(paths) {
        return Err(ExecutionFailure::not_launched(error));
    }
    let claimed = db(
        handle,
        deadline,
        execution::claim_with_preflight(
            pool,
            &actor,
            request.organization_id,
            request.run_id,
            request.attempt_id,
            host,
            |config| {
                if request.cancelled.load(Ordering::Acquire) {
                    return Err(runtime_bindings::Error::Http(
                        409,
                        "Native Chat execution was cancelled".into(),
                    ));
                }
                match config.identity.runtime_type.as_str() {
                    "codex_local" => profile::validate(config, paths),
                    "hermes_local" if allow_hermes => hermes::validate_config(config, host, paths),
                    "pi_local" => pi::validate_config(config, host, paths),
                    "claude_local" if allow_hermes => config
                        .claude
                        .as_ref()
                        .map(|_| ())
                        .ok_or(Error::UnsupportedConfiguration),
                    "cursor" | "cursor_local" if allow_hermes => config
                        .cursor
                        .as_ref()
                        .map(|_| ())
                        .ok_or(Error::UnsupportedConfiguration),
                    "opencode_local" if allow_hermes => config
                        .opencode
                        .as_ref()
                        .filter(|value| value.executable().is_some())
                        .map(|_| ())
                        .ok_or(Error::UnsupportedConfiguration),
                    _ => Err(Error::UnsupportedConfiguration),
                }
                .map_err(|_| {
                    runtime_bindings::Error::Http(
                        409,
                        "Native Chat runtime configuration is unsupported".into(),
                    )
                })
            },
        ),
    )
    .map_err(ExecutionFailure::not_launched)?;
    let (execution_principal, claimed_fence, claimed_config, connection_launch_permit) =
        claimed.into_execution_parts();
    // Request authentication has served its sole purpose. Every continuation
    // below is fenced by the principal minted in the same D1 claim transaction.
    drop(actor);
    if claimed_config.identity.runtime_type == "hermes_local" {
        return hermes::run_claimed(
            handle,
            pool,
            execution_principal,
            claimed_fence,
            claimed_config,
            connection_launch_permit,
            request.cancelled,
            deadline,
            paths,
        )
        .map(NativeExecutionObservation::Hermes);
    }
    if claimed_config.identity.runtime_type == "pi_local" {
        return pi::run_claimed(
            handle,
            pool,
            execution_principal,
            claimed_fence,
            claimed_config,
            connection_launch_permit,
            request.cancelled,
            deadline,
            paths,
        )
        .map(NativeExecutionObservation::Pi);
    }
    // Claude Code, Cursor ACP, and OpenCode keep provider-native identity and
    // receipts. The shared D1 worker owns the checkpoint transitions around
    // this branch; this executor only dispatches the admitted input through
    // the matching provider boundary and returns its typed observation.
    if matches!(
        claimed_config.identity.runtime_type.as_str(),
        "claude_local" | "cursor" | "cursor_local" | "opencode_local"
    ) {
        let snapshot = match db(
            handle,
            deadline,
            execution::current_checkpoint(pool, &execution_principal, &claimed_fence),
        ) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Err(ExecutionFailure::before_launch(
                    error,
                    execution_principal,
                    claimed_fence,
                ));
            }
        };
        let input = match db(
            handle,
            deadline,
            execution::load_submission(pool, &execution_principal, &claimed_fence),
        ) {
            Ok(input) => input,
            Err(error) => {
                return Err(ExecutionFailure::before_launch(
                    error,
                    execution_principal,
                    claimed_fence,
                ));
            }
        };
        let body = input.body().to_owned();
        let run_id = claimed_fence.identity().run_id.to_owned();
        let attempt_id = claimed_fence.identity().attempt_id.to_owned();
        let owner_token = claimed_fence.run_execution_owner_token().to_owned();
        let existing_claude = snapshot
            .claude_session
            .as_ref()
            .map(|session| session.as_str().to_owned());
        let existing_cursor = snapshot
            .cursor_session
            .as_ref()
            .map(|session| session.as_str().to_owned());
        let existing_opencode = snapshot
            .opencode_session
            .as_ref()
            .map(|session| session.as_str().to_owned());
        let runtime = claimed_config.identity.runtime_type.clone();
        return match runtime.as_str() {
            "claude_local" => {
                let Some(local) = claimed_config.claude.as_ref() else {
                    return Err(ExecutionFailure::before_launch(
                        Error::UnsupportedConfiguration,
                        execution_principal,
                        claimed_fence,
                    ));
                };
                match execute_claude_turn(
                    handle,
                    &claimed_config,
                    local,
                    paths,
                    connection_launch_permit,
                    &run_id,
                    &attempt_id,
                    &owner_token,
                    existing_claude.as_deref(),
                    &body,
                    deadline.saturating_duration_since(Instant::now()),
                ) {
                    Ok(observation) => Ok(NativeExecutionObservation::Claude(
                        ClaudeNativeExecutionObservation {
                            execution_principal,
                            fence: claimed_fence,
                            observation,
                        },
                    )),
                    Err(error) => Err(ExecutionFailure::after_claim(
                        Error::ClaudeTransport(error),
                        execution_principal,
                        claimed_fence,
                        None,
                    )),
                }
            }
            "cursor" | "cursor_local" => {
                let Some(local) = claimed_config.cursor.as_ref() else {
                    return Err(ExecutionFailure::before_launch(
                        Error::UnsupportedConfiguration,
                        execution_principal,
                        claimed_fence,
                    ));
                };
                match execute_cursor_turn(
                    &claimed_config,
                    local,
                    paths,
                    connection_launch_permit,
                    &run_id,
                    &attempt_id,
                    &owner_token,
                    existing_cursor.as_deref(),
                    &body,
                    deadline.saturating_duration_since(Instant::now()),
                ) {
                    Ok(observation) => Ok(NativeExecutionObservation::Cursor(
                        CursorNativeExecutionObservation {
                            execution_principal,
                            fence: claimed_fence,
                            observation,
                        },
                    )),
                    Err(error) => Err(ExecutionFailure::after_claim(
                        Error::CursorTransport(error),
                        execution_principal,
                        claimed_fence,
                        None,
                    )),
                }
            }
            "opencode_local" => {
                let Some(local) = claimed_config.opencode.as_ref() else {
                    return Err(ExecutionFailure::before_launch(
                        Error::UnsupportedConfiguration,
                        execution_principal,
                        claimed_fence,
                    ));
                };
                match execute_opencode_turn(
                    handle,
                    local,
                    paths,
                    connection_launch_permit,
                    &run_id,
                    &attempt_id,
                    &owner_token,
                    existing_opencode.as_deref(),
                    &body,
                    deadline.saturating_duration_since(Instant::now()),
                ) {
                    Ok(observation) => Ok(NativeExecutionObservation::OpenCode(
                        OpenCodeNativeExecutionObservation {
                            execution_principal,
                            fence: claimed_fence,
                            observation,
                        },
                    )),
                    Err(error) => Err(ExecutionFailure::after_claim(
                        Error::OpenCodeExecution(error.to_string()),
                        execution_principal,
                        claimed_fence,
                        None,
                    )),
                }
            }
            _ => Err(ExecutionFailure::before_launch(
                Error::UnsupportedConfiguration,
                execution_principal,
                claimed_fence,
            )),
        };
    }
    let (launch, snapshot) = match (|| -> Result<_> {
        if request.cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        db(
            handle,
            deadline,
            execution::validate_submission_source(pool, &execution_principal, &claimed_fence),
        )?;
        let launch = process_launch(&claimed_config, &claimed_fence, paths)?;
        let snapshot = db(
            handle,
            deadline,
            execution::current_checkpoint(pool, &execution_principal, &claimed_fence),
        )?;
        Ok((launch, snapshot))
    })() {
        Ok(value) => value,
        Err(error) => {
            return Err(ExecutionFailure::before_launch(
                error,
                execution_principal,
                claimed_fence,
            ));
        }
    };
    // Finish all fallible prelaunch reads before creating the process owner.
    // A launch error may have created an external owner; do not infer cleanup.
    let launch_fence = claimed_fence.clone();
    let transport = match OwnedTransport::launch_external_for_execution(
        launch,
        &paths.process_host,
        connection_launch_permit,
    ) {
        Ok(transport) => transport,
        Err(error) => {
            return Err(ExecutionFailure::after_claim(
                error.into(),
                execution_principal,
                launch_fence,
                None,
            ));
        }
    };
    let mut driver = Driver {
        handle,
        pool,
        actor: &execution_principal,
        fence: claimed_fence,
        config: claimed_config,
        transport,
        snapshot,
        cancelled: request.cancelled,
        deadline,
        paths,
        renewed: Instant::now(),
        notifications: VecDeque::new(),
        stop: None,
        stop_checked: Instant::now() - Duration::from_secs(1),
        connection_registered: false,
        turn_response: None,
        spawned: false,
        interrupt_attempted: false,
        interrupt_request: None,
    };
    let result = driver.execute();
    // Stop even after permission, database, protocol, or provider failure. A
    // returned cleanup receipt remains opaque evidence for a narrow Stop-only
    // finalizer; the disposition enum is never sufficient authority.
    let cleanup_receipt = driver.stop_and_observe_cleanup();
    let provider_terminal = match result {
        Ok(terminal) => terminal,
        Err(error) => {
            let fence = driver.fence.clone();
            drop(driver);
            return Err(ExecutionFailure::after_claim(
                error,
                execution_principal,
                fence,
                cleanup_receipt,
            ));
        }
    };
    let Some(turn_receipt) = driver.transport.take_turn_receipt() else {
        let fence = driver.fence.clone();
        drop(driver);
        return Err(ExecutionFailure::after_claim(
            Error::InvalidProviderObservation,
            execution_principal,
            fence,
            cleanup_receipt,
        ));
    };
    if provider_terminal.thread_id != turn_receipt.thread_id()
        || provider_terminal.turn_id != turn_receipt.turn_id()
        || provider_terminal.status != turn_receipt.status()
    {
        let fence = driver.fence.clone();
        drop(driver);
        return Err(ExecutionFailure::after_claim(
            Error::InvalidProviderObservation,
            execution_principal,
            fence,
            cleanup_receipt,
        ));
    }
    let cleanup_proven = cleanup_receipt
        .as_ref()
        .is_some_and(|cleanup| cleanup_proves_owned_execution(&driver.fence, cleanup));
    let fence = driver.fence.clone();
    let stop = driver.stop.take();
    drop(driver);
    Ok(NativeExecutionObservation::Codex(ExecutionObservation {
        execution_principal,
        fence,
        turn_receipt,
        cleanup_receipt,
        cleanup_proven,
        stop,
    }))
}

fn validate_paths(paths: &HostPaths) -> Result<()> {
    for path in [
        &paths.process_host,
        &paths.runtime_root,
        &paths.isolated_home,
    ] {
        if !path.is_absolute() || path.canonicalize().as_ref().ok() != Some(path) {
            return Err(Error::UnsupportedConfiguration);
        }
    }
    if !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
    {
        return Err(Error::UnsupportedConfiguration);
    }
    Ok(())
}

fn process_launch(
    config: &ResolvedCodexConfig,
    fence: &ExecutionFence,
    paths: &HostPaths,
) -> Result<ProcessLaunch> {
    if config.plan_mode || (config.search_enabled && !config.profile.native_managed) {
        return Err(Error::UnsupportedConfiguration);
    }
    profile::validate(config, paths)?;
    let utf8 = |path: &Path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or(Error::UnsupportedConfiguration)
    };
    let mut env = BTreeMap::new();
    env.insert("HOME".into(), utf8(&paths.isolated_home)?);
    env.insert("USERPROFILE".into(), utf8(&paths.isolated_home)?);
    env.insert("CODEX_HOME".into(), utf8(&config.profile.home)?);
    env.insert("PATH".into(), config.executable_search_path.clone());
    Ok(ProcessLaunch {
        executable: utf8(&config.executable)?,
        // Keep extensions in the selected Codex profile active. Native
        // execution validates the effective policy after `config/read` and
        // lets the App Server inherit it; it never rewrites the profile or
        // supplies per-Thread policy overrides.
        argv: if config.profile.id.ends_with(":operator-default") {
            vec!["app-server".into()]
        } else {
            vec!["app-server".into(), "--strict-config".into()]
        },
        cwd: utf8(if config.profile.native_managed {
            &config.cwd
        } else {
            &paths.isolated_home
        })?,
        env,
        request_id: fence.identity().attempt_id.into(),
        run_id: fence.identity().run_id.into(),
        attempt_id: fence.identity().attempt_id.into(),
        owner_token: fence.run_execution_owner_token().into(),
        runtime_root: utf8(&paths.runtime_root)?,
    })
}

struct Driver<'a> {
    handle: &'a Handle,
    pool: &'a PgPool,
    actor: &'a NativeChatExecutionPrincipal,
    fence: ExecutionFence,
    config: ResolvedCodexConfig,
    paths: &'a HostPaths,
    transport: OwnedTransport,
    snapshot: CheckpointSnapshot,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    renewed: Instant,
    notifications: VecDeque<(String, Value)>,
    stop: Option<execution::StopIntent>,
    stop_checked: Instant,
    connection_registered: bool,
    turn_response: Option<EffectResponseReceipt>,
    spawned: bool,
    interrupt_attempted: bool,
    interrupt_request: Option<RequestId>,
}

impl Driver<'_> {
    fn validate_configuration(&mut self) -> Result<()> {
        profile::validate(&self.config, self.paths)?;
        let observed = self.rpc(
            "config/read",
            json!({"cwd":self.config.cwd.to_string_lossy(),"includeLayers":true}),
        )?;
        if self.config.profile.native_managed {
            profile::validate_selected_layers(
                &observed,
                &self.config.profile.home,
                &self.config.cwd,
                self.config.bypass_approvals_and_sandbox,
            )?;
        } else {
            profile::validate_layers(&observed, &self.config.profile.home)?;
        }
        profile::validate(&self.config, self.paths)?;
        Ok(())
    }

    fn check_cancelled(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) || self.stop.is_some() {
            return Err(Error::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(Error::Deadline);
        }
        Ok(())
    }

    fn poll_stop(&mut self) -> Result<()> {
        self.stop = db(
            self.handle,
            self.deadline,
            execution::observe_stop(self.pool, self.actor, &self.fence),
        )?;
        if let Some(stop) = &self.stop
            && !self.connection_registered
        {
            let connection = self.transport.connection_receipt();
            db(
                self.handle,
                self.deadline,
                execution::bind_stopping_connection(
                    self.pool,
                    self.actor,
                    &self.fence,
                    stop,
                    &connection,
                ),
            )?;
            self.connection_registered = true;
        }
        self.stop_checked = Instant::now();
        Ok(())
    }

    fn interrupt_if_ready(&mut self) -> Result<()> {
        if self.interrupt_attempted
            || self.snapshot.phase != NativeChatProtocolPhase::TurnKnown
            || self.notifications.iter().any(|(_, params)| {
                self.snapshot
                    .thread_id
                    .as_ref()
                    .zip(self.snapshot.turn_id.as_ref())
                    .is_some_and(|(thread, turn)| {
                        wire::terminal(params.clone(), thread, turn).is_ok()
                    })
            })
        {
            return Ok(());
        }
        let Some(stop) = &self.stop else {
            return Ok(());
        };
        let response = self
            .turn_response
            .as_ref()
            .ok_or(Error::InvalidProviderObservation)?;
        let permit = db(
            self.handle,
            self.deadline,
            execution::reserve_interrupt(self.pool, self.actor, &self.fence, stop, response),
        )?;
        self.interrupt_attempted = true;
        if let Some(permit) = permit {
            self.interrupt_request = Some(
                permit
                    .dispatch(&mut self.transport)
                    .map_err(Error::Persistence)??,
            );
        }
        Ok(())
    }

    fn next(&mut self) -> Result<TransportEvent> {
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return Err(Error::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Err(Error::Deadline);
            }
            if self.stop_checked.elapsed() >= Duration::from_millis(200) {
                self.poll_stop()?;
            }
            self.interrupt_if_ready()?;
            if self.renewed.elapsed() >= Duration::from_secs(5) {
                if let Some(stop) = &self.stop {
                    db(
                        self.handle,
                        self.deadline,
                        execution::renew_stopping_lease(self.pool, self.actor, &self.fence, stop),
                    )?;
                } else {
                    let result = db(
                        self.handle,
                        self.deadline,
                        execution::renew_lease(self.pool, self.actor, &self.fence),
                    );
                    if matches!(
                        &result,
                        Err(Error::Persistence(runtime_bindings::Error::Http(409, _)))
                    ) {
                        self.poll_stop()?;
                        if let Some(stop) = &self.stop {
                            db(
                                self.handle,
                                self.deadline,
                                execution::renew_stopping_lease(
                                    self.pool,
                                    self.actor,
                                    &self.fence,
                                    stop,
                                ),
                            )?;
                        } else {
                            result?;
                        }
                    } else {
                        result?;
                    }
                }
                self.renewed = Instant::now();
            }
            if let Some(event) = self.transport.poll(Duration::from_millis(100))? {
                match &event {
                    TransportEvent::FrameWritten {
                        request_id: Some(id),
                    } if self.interrupt_request.as_ref() == Some(id) => continue,
                    TransportEvent::Rpc(SessionObservation::Completed { id, method, .. })
                        if self.interrupt_request.as_ref() == Some(id)
                            && method == "turn/interrupt" =>
                    {
                        // Acknowledgement (including rejection) is not terminal proof.
                        continue;
                    }
                    TransportEvent::Rpc(SessionObservation::Incoming(Message::Request {
                        ..
                    })) => return Err(Error::ApprovalRequired),
                    TransportEvent::Lifecycle(value)
                        if matches!(value["type"].as_str(), Some("app-exit" | "terminal")) =>
                    {
                        return Err(Error::ProcessExited);
                    }
                    _ => return Ok(event),
                }
            }
        }
    }

    fn remember(&mut self, event: TransportEvent) -> Result<()> {
        if let TransportEvent::Rpc(SessionObservation::Incoming(Message::Notification {
            method,
            params,
        })) = event
        {
            // Keep terminal correlation private while persisting each visible
            // output observation through the typed, connection-bound receipt.
            if method == "turn/completed" {
                if !matches!(
                    self.snapshot.phase,
                    NativeChatProtocolPhase::InputIndeterminate
                        | NativeChatProtocolPhase::TurnKnown
                ) {
                    return Err(Error::InvalidProviderObservation);
                }
                if self.notifications.len() >= 4 {
                    return Err(Error::InvalidProviderObservation);
                }
                self.notifications
                    .push_back((method, params.ok_or(Error::InvalidProviderObservation)?));
            }
        } else if matches!(event, TransportEvent::Rpc(_)) {
            return Err(Error::InvalidProviderObservation);
        }
        self.persist_visible_outputs()?;
        Ok(())
    }

    fn persist_visible_outputs(&mut self) -> Result<()> {
        for receipt in self.transport.take_visible_output_receipts() {
            // A Stop freezes the already committed prefix. Drop all later
            // receipts instead of letting provider tail output change it.
            if self.stop.is_some() {
                continue;
            }
            match db(
                self.handle,
                self.deadline,
                execution::record_visible_output(self.pool, self.actor, &self.fence, &receipt),
            ) {
                Ok(_) => (),
                Err(error @ Error::Persistence(runtime_bindings::Error::Http(409, _))) => {
                    self.poll_stop()?;
                    if self.stop.is_some() {
                        // The failed write crossed the durable Stop cutoff.
                        // Remaining queued receipts are intentionally dropped.
                        return Ok(());
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn response(&mut self, id: RequestId, method: &str) -> Result<Value> {
        let mut written = false;
        let mut outcome = None;
        loop {
            match self.next()? {
                TransportEvent::FrameWritten { request_id } if request_id.as_ref() == Some(&id) => {
                    written = true
                }
                TransportEvent::Rpc(SessionObservation::Completed {
                    id: actual,
                    method: actual_method,
                    outcome: value,
                }) if actual == id && actual_method == method => {
                    if outcome.is_some() {
                        return Err(Error::InvalidProviderObservation);
                    }
                    outcome = Some(value.map_err(|_| Error::ProviderRejected)?);
                }
                event => self.remember(event)?,
            }
            if written && let Some(value) = outcome.take() {
                return Ok(value);
            }
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        self.check_cancelled()?;
        let id = self.transport.request(method, params)?;
        self.response(id, method)
    }

    fn transition(
        &mut self,
        transition: CheckpointTransition,
    ) -> Result<execution::CheckpointReceipt> {
        let receipt = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.actor,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                transition,
            ),
        )?;
        self.snapshot = receipt.snapshot().clone();
        Ok(receipt)
    }

    fn record_response(
        &mut self,
        transition: CheckpointTransition,
        response: &EffectResponseReceipt,
    ) -> Result<()> {
        if self.stop.is_none() {
            match self.transition(transition) {
                Ok(_) => return Ok(()),
                Err(error @ Error::Persistence(runtime_bindings::Error::Http(409, _))) => {
                    self.poll_stop()?;
                    if self.stop.is_none() {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        let stop = self
            .stop
            .as_ref()
            .ok_or(Error::InvalidProviderObservation)?;
        let receipt = db(
            self.handle,
            self.deadline,
            execution::advance_stopping_checkpoint(
                self.pool,
                self.actor,
                &self.fence,
                stop,
                self.snapshot.phase,
                self.snapshot.revision,
                response,
            ),
        )?;
        self.snapshot = receipt.snapshot().clone();
        Ok(())
    }

    fn observe_terminal(&mut self, thread_id: String, turn_id: String) -> Result<()> {
        // The finalizer validates the opaque TurnReceipt after cleanup. Stop
        // needs no raw terminal checkpoint mutation or invented Interrupted status.
        if self.stop.is_some() {
            return Ok(());
        }
        match self.transition(CheckpointTransition::ObserveProviderTerminal { thread_id, turn_id })
        {
            Ok(_) => Ok(()),
            Err(error @ Error::Persistence(runtime_bindings::Error::Http(409, _))) => {
                self.poll_stop()?;
                if self.stop.is_some() {
                    Ok(())
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }

    fn execute(&mut self) -> Result<ProviderTerminal> {
        loop {
            if let TransportEvent::Lifecycle(value) = self.next()?
                && value["type"] == "spawned"
            {
                self.spawned = true;
                break;
            }
        }
        let initialized = self.rpc("initialize", json!({"clientInfo":{"name":"rudder-native-chat","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}))?;
        if !initialized["userAgent"]
            .as_str()
            .is_some_and(|value| value.starts_with("rudder-native-chat/0.163.0-alpha.10.2 ("))
            || initialized["codexHome"].as_str() != self.config.profile.home.to_str()
        {
            return Err(Error::UnsupportedConfiguration);
        }
        self.transport.notify("initialized", json!({}))?;
        loop {
            match self.next()? {
                TransportEvent::FrameWritten { request_id: None } => break,
                event => self.remember(event)?,
            }
        }
        // Reject static provider configuration before marking any operation as
        // indeterminate. Recheck again immediately before each actual effect.
        self.validate_configuration()?;
        match self.snapshot.phase {
            NativeChatProtocolPhase::NoThreadRequest => {
                db(
                    self.handle,
                    self.deadline,
                    execution::validate_submission_source(self.pool, self.actor, &self.fence),
                )?;
                let mut receipt = self.transition(CheckpointTransition::PrepareThreadStart)?;
                let permit = receipt
                    .take_effect_permit()
                    .ok_or(Error::InvalidProviderObservation)?;
                let authorized = db(
                    self.handle,
                    self.deadline,
                    execution::authorize_effect(self.pool, self.actor, permit, None),
                )?;
                self.validate_configuration()?;
                let params = wire::thread_params(&self.config);
                self.check_cancelled()?;
                let id = authorized
                    .dispatch(|effect| match effect {
                        EffectDispatch::StartThread => self
                            .transport
                            .request_with_effect_receipt("thread/start", params),
                        _ => Err(TransportError::InvalidLaunch),
                    })
                    .map_err(Error::Persistence)??;
                let response = self.response(id, "thread/start")?;
                if response["thread"]["ephemeral"] != false {
                    return Err(Error::InvalidProviderObservation);
                }
                let thread_id = wire::locator(&response["thread"]["id"])?;
                let proof = self
                    .transport
                    .take_effect_response_receipt()
                    .ok_or(Error::InvalidProviderObservation)?;
                self.record_response(CheckpointTransition::RecordThread { thread_id }, &proof)?;
                self.check_cancelled()?;
            }
            NativeChatProtocolPhase::ThreadKnown => {
                let thread = self
                    .snapshot
                    .thread_id
                    .clone()
                    .ok_or(Error::InvalidProviderObservation)?;
                let mut params = wire::thread_params(&self.config);
                params["threadId"] = json!(thread);
                params["excludeTurns"] = json!(true);
                db(
                    self.handle,
                    self.deadline,
                    execution::validate_submission_source(self.pool, self.actor, &self.fence),
                )?;
                self.validate_configuration()?;
                let response = self.rpc("thread/resume", params)?;
                if wire::locator(&response["thread"]["id"])? != thread {
                    return Err(Error::InvalidProviderObservation);
                }
            }
            _ => return Err(Error::InvalidProviderObservation),
        }
        self.transition(CheckpointTransition::PrepareInput)?;
        let input = db(
            self.handle,
            self.deadline,
            execution::load_submission(self.pool, self.actor, &self.fence),
        )?;
        let mut receipt = self.transition(CheckpointTransition::MarkInputIndeterminate)?;
        let permit = receipt
            .take_effect_permit()
            .ok_or(Error::InvalidProviderObservation)?;
        let authorized = db(
            self.handle,
            self.deadline,
            execution::authorize_effect(self.pool, self.actor, permit, Some(input)),
        )?;
        self.validate_configuration()?;
        self.check_cancelled()?;
        let id = authorized
            .dispatch(|effect| match effect {
                EffectDispatch::SubmitInput {
                    thread_id,
                    source_message_id,
                    body,
                } => {
                    self.transport.arm_turn_receipt()?;
                    self.transport.request_with_effect_receipt(
                        "turn/start",
                        wire::turn_params(thread_id, source_message_id, body, &self.config),
                    )
                }
                _ => Err(TransportError::InvalidLaunch),
            })
            .map_err(Error::Persistence)??;
        let response = self.response(id, "turn/start")?;
        let turn_id = wire::locator(&response["turn"]["id"])?;
        let thread_id = self
            .snapshot
            .thread_id
            .clone()
            .ok_or(Error::InvalidProviderObservation)?;
        let proof = self
            .transport
            .take_effect_response_receipt()
            .ok_or(Error::InvalidProviderObservation)?;
        self.record_response(
            CheckpointTransition::RecordTurn {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            },
            &proof,
        )?;
        self.turn_response = Some(proof);
        self.transport
            .begin_turn_receipt(thread_id.clone(), turn_id.clone())?;
        // The transport may have buffered exact-turn output before the
        // turn/start response identified its opaque Turn. Persist it now that
        // both the durable checkpoint and receipt tracker are correlated.
        self.persist_visible_outputs()?;
        loop {
            if let Some((_, value)) = self.notifications.pop_front() {
                // Replayed terminals from another Turn cannot suppress this
                // Turn's interrupt or become its terminal observation.
                if wire::locator(&value["threadId"])? != thread_id
                    || wire::locator(&value["turn"]["id"])? != turn_id
                {
                    continue;
                }
                let terminal = wire::terminal(value, &thread_id, &turn_id)?;
                self.observe_terminal(thread_id, turn_id)?;
                return Ok(terminal);
            }
            let event = self.next()?;
            self.remember(event)?;
        }
    }

    fn stop_and_observe_cleanup(&mut self) -> Option<CleanupReceipt> {
        // `next()` may already have consumed the host's terminal lifecycle
        // frame while `spawned` was still false locally. Preserve a cleanup
        // receipt the transport has already validated before polling again;
        // a subsequent `Closed` poll cannot recover that consumed frame.
        if let Some(receipt) = self.transport.take_cleanup_receipt() {
            return Some(receipt);
        }
        if !self.spawned {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                match self.transport.poll(Duration::from_millis(100)) {
                    Ok(Some(TransportEvent::Lifecycle(value))) if value["type"] == "spawned" => {
                        self.spawned = true;
                        break;
                    }
                    Ok(Some(TransportEvent::Lifecycle(value))) if value["type"] == "terminal" => {
                        return self.transport.take_cleanup_receipt();
                    }
                    Err(_) => return None,
                    _ => (),
                }
            }
            if !self.spawned {
                return None;
            }
        }
        if self.transport.stop().is_err() {
            return None;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match self.transport.poll(Duration::from_millis(100)) {
                Ok(Some(TransportEvent::Lifecycle(value))) if value["type"] == "terminal" => {
                    return self.transport.take_cleanup_receipt();
                }
                Err(_) => return None,
                _ => (),
            }
        }
        None
    }
}

#[cfg(all(test, unix))]
extern crate self as rudder_native_chat_executor;

#[cfg(all(test, unix))]
#[path = "../tests/workflow/fixture.rs"]
mod cleanup_claim_fixture;

#[cfg(all(test, unix))]
mod cleanup_claim_tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires RUDDER_TEST_PROCESS_HOST; covered by Rust D1 real-entry smoke"]
    async fn browser_request_credentials_cannot_be_used_as_execution_authority_without_claim() {
        let host = cleanup_claim_fixture::FixtureHost::new("complete");
        let paths = host.paths();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .expect("lazy test pool");
        let session_id = "browser-session-preclaim-cancel";
        let actor =
            rudder_d1_persistence::native_chat::BrowserPrincipal::from_trusted_browser_auth(
                "native-chat-executor-owner",
                cleanup_claim_fixture::ORG,
                session_id,
                rudder_d1_persistence::native_chat::BrowserCredentialBinding::session(
                    session_id, [3; 32],
                ),
            )
            .expect("Foundation-authenticated browser principal");
        let cancelled = AtomicBool::new(true);

        let result = run_observed_with_request_actor_on_blocking_thread(
            &Handle::current(),
            &pool,
            actor,
            host.context(),
            &paths,
            ExecutionRequest {
                organization_id: cleanup_claim_fixture::ORG,
                run_id: "21000000-0000-4000-8000-000000000391",
                attempt_id: "22000000-0000-4000-8000-000000000391",
                timeout: Duration::from_secs(30),
                cancelled: &cancelled,
            },
        );
        let failure = match result {
            Err(failure) => failure,
            Ok(_) => panic!("pre-claim cancellation must not proceed"),
        };

        assert_eq!(
            failure.process_disposition(),
            ProcessDisposition::NotLaunched
        );
        assert!(failure.fence().is_none());
        assert!(failure.execution_principal().is_none());
    }

    fn stop_and_take_cleanup(transport: &mut OwnedTransport) -> CleanupReceipt {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut spawned = false;
        while Instant::now() < deadline {
            match transport.poll(Duration::from_millis(100)) {
                Ok(Some(TransportEvent::Lifecycle(value))) if value["type"] == "spawned" => {
                    spawned = true;
                    break;
                }
                Ok(Some(TransportEvent::Lifecycle(value))) if value["type"] == "terminal" => {
                    return transport
                        .take_cleanup_receipt()
                        .expect("terminal host wrote owned cleanup receipt");
                }
                Ok(_) => (),
                Err(error) => panic!("owned host startup failed before cleanup: {error}"),
            }
        }
        assert!(spawned, "owned host did not report the child as spawned");
        transport.stop().expect("queue owned host Stop");
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match transport.poll(Duration::from_millis(100)) {
                Ok(Some(TransportEvent::Lifecycle(value))) if value["type"] == "terminal" => {
                    return transport
                        .take_cleanup_receipt()
                        .expect("host wrote owned cleanup receipt");
                }
                Ok(_) => (),
                Err(error) => panic!("owned host cleanup failed: {error}"),
            }
        }
        panic!("owned host cleanup timed out")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires RUDDER_TEST_PROCESS_HOST and disposable PostgreSQL"]
    async fn same_owner_epoch_wrong_claim_cleanup_does_not_prove_quiescence() {
        let (database, host, actor, run_id, attempt_id) =
            cleanup_claim_fixture::database_and_admission("complete").await;
        let claimed = cleanup_claim_fixture::claim(
            &database.pool,
            &actor,
            cleanup_claim_fixture::ORG,
            &run_id,
            &attempt_id,
            host.context(),
        )
        .await
        .expect("claim admitted execution");
        let (fence, config, permit) = claimed.into_parts();
        let identity = fence.identity();
        let launch = process_launch(&config, &fence, &host.paths()).expect("valid launch");
        let mut owned = OwnedTransport::launch_external_for_execution(
            launch,
            &host.paths().process_host,
            permit,
        )
        .expect("launch with claim-issued permit");

        // This second connection deliberately shares every durable owner
        // dimension and epoch, but its different claim ID cannot prove the
        // first connection quiescent.
        let wrong_permit = rudder_codex_app_server::ConnectionLaunchPermit::from_claim(
            identity.run_id.to_owned(),
            identity.attempt_id.to_owned(),
            fence.run_execution_owner_token().to_owned(),
            identity.connection_epoch,
            "different-connection-claim".into(),
        );
        // A process-host runtime root owns a single child. Keep the same
        // durable Run/Attempt/owner/epoch identity to exercise claim binding,
        // but give the deliberately wrong connection its own task-owned host
        // paths so process-host exclusivity does not reject it first.
        let decoy_root = tempfile::tempdir().expect("create decoy host paths");
        let decoy_runtime_root = decoy_root.path().join("runtime-root");
        let decoy_isolated_home = decoy_root.path().join("isolated-home");
        std::fs::create_dir_all(&decoy_runtime_root).expect("create decoy runtime root");
        std::fs::create_dir_all(&decoy_isolated_home).expect("create decoy isolated home");
        let base_paths = host.paths();
        let decoy_paths = HostPaths {
            process_host: base_paths.process_host,
            runtime_root: decoy_runtime_root
                .canonicalize()
                .expect("canonical decoy runtime root"),
            isolated_home: decoy_isolated_home
                .canonicalize()
                .expect("canonical decoy isolated home"),
        };
        let launch = process_launch(&config, &fence, &decoy_paths).expect("valid decoy launch");
        let mut decoy = OwnedTransport::launch_external_for_execution(
            launch,
            &decoy_paths.process_host,
            wrong_permit,
        )
        .expect("launch decoy connection");
        let wrong_cleanup = stop_and_take_cleanup(&mut decoy);
        assert!(wrong_cleanup.matches_execution(
            identity.run_id,
            identity.attempt_id,
            fence.run_execution_owner_token(),
        ));
        assert_eq!(
            wrong_cleanup.connection_epoch(),
            Some(identity.connection_epoch)
        );
        assert!(!cleanup_proves_owned_execution(&fence, &wrong_cleanup));
        let failure = ExecutionFailure::after_launch(
            Error::ProcessExited,
            fence.clone(),
            Some(wrong_cleanup),
        );
        assert_eq!(
            failure.process_disposition(),
            ProcessDisposition::Unresolved
        );
        assert!(!failure.process_quiescent());
        assert!(failure.cleanup_receipt().is_none());

        let owned_cleanup = stop_and_take_cleanup(&mut owned);
        assert!(cleanup_proves_owned_execution(&fence, &owned_cleanup));
        let failure =
            ExecutionFailure::after_launch(Error::ProcessExited, fence, Some(owned_cleanup));
        assert_eq!(
            failure.process_disposition(),
            ProcessDisposition::CleanupProven
        );
        assert!(failure.process_quiescent());
        assert!(failure.cleanup_receipt().is_some());
    }
}
