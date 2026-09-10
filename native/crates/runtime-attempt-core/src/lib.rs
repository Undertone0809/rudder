//! Pure, bounded heartbeat attempt and network-recovery state.
//!
//! The crate contains only data validation and deterministic state transitions. It deliberately
//! does not perform network, database, process, clock, or sleep operations; an adapter can carry
//! the returned checkpoint and recovery plan to the current runtime authority.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

pub const ATTEMPT_PROTOCOL_VERSION: u16 = 1;
pub const MAX_ATTEMPTS: u8 = 6;
pub const MAX_ID_BYTES: usize = 255;
pub const NETWORK_BACKOFF_SECONDS: [u64; 6] = [2, 5, 10, 20, 30, 60];
pub const MAX_JITTER_PERCENT: u64 = 25;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    InvalidInput,
    InvalidTransition,
    StaleLeaseFence,
    LeaseExpired,
    CancellationRequested,
    AlreadyTerminal,
    IdempotencyConflict,
    RetryNotDue,
    RecoveryChoiceMismatch,
    AttemptLimitReached,
    CheckpointInvalid,
    NetworkResumeUnsafe,
    NetworkRetryExhausted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttemptError {
    code: &'static str,
    kind: ErrorKind,
    message: String,
}

impl AttemptError {
    fn new(code: &'static str, kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            code,
            kind,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_input", ErrorKind::InvalidInput, message)
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for AttemptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AttemptError {}

fn bounded_string(
    value: impl Into<String>,
    field: &'static str,
    max_bytes: usize,
) -> Result<String, AttemptError> {
    let value = value.into();
    if value.trim().is_empty() {
        return Err(AttemptError::invalid(format!("{field} must not be empty")));
    }
    if value.len() > max_bytes {
        return Err(AttemptError::invalid(format!(
            "{field} exceeds {max_bytes} bytes"
        )));
    }
    Ok(value)
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatIdentity {
    pub organization_id: String,
    pub run_id: String,
    pub agent_id: String,
}

impl HeartbeatIdentity {
    pub fn new(
        organization_id: impl Into<String>,
        run_id: impl Into<String>,
        agent_id: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self {
            organization_id: bounded_string(organization_id, "organization_id", MAX_ID_BYTES)?,
            run_id: bounded_string(run_id, "run_id", MAX_ID_BYTES)?,
            agent_id: bounded_string(agent_id, "agent_id", MAX_ID_BYTES)?,
        })
    }

    pub fn attempt(&self, attempt: u8) -> Result<AttemptIdentity, AttemptError> {
        AttemptIdentity::new(
            self.organization_id.clone(),
            self.run_id.clone(),
            self.agent_id.clone(),
            attempt,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptIdentity {
    pub organization_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub attempt: u8,
}

impl AttemptIdentity {
    pub fn new(
        organization_id: impl Into<String>,
        run_id: impl Into<String>,
        agent_id: impl Into<String>,
        attempt: u8,
    ) -> Result<Self, AttemptError> {
        if !(1..=MAX_ATTEMPTS).contains(&attempt) {
            return Err(AttemptError::invalid(format!(
                "attempt must be between 1 and {MAX_ATTEMPTS}"
            )));
        }
        Ok(Self {
            organization_id: bounded_string(organization_id, "organization_id", MAX_ID_BYTES)?,
            run_id: bounded_string(run_id, "run_id", MAX_ID_BYTES)?,
            agent_id: bounded_string(agent_id, "agent_id", MAX_ID_BYTES)?,
            attempt,
        })
    }

    pub fn heartbeat_identity(&self) -> HeartbeatIdentity {
        HeartbeatIdentity {
            organization_id: self.organization_id.clone(),
            run_id: self.run_id.clone(),
            agent_id: self.agent_id.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseFence {
    pub owner_id: String,
    pub epoch: u64,
    pub issued_at_millis: u64,
    pub expires_at_millis: u64,
}

impl LeaseFence {
    pub fn new(
        owner_id: impl Into<String>,
        epoch: u64,
        issued_at_millis: u64,
        expires_at_millis: u64,
    ) -> Result<Self, AttemptError> {
        if epoch == 0 {
            return Err(AttemptError::invalid(
                "lease epoch must be greater than zero",
            ));
        }
        if expires_at_millis <= issued_at_millis {
            return Err(AttemptError::invalid(
                "lease expiry must be after its issue time",
            ));
        }
        Ok(Self {
            owner_id: bounded_string(owner_id, "lease owner", MAX_ID_BYTES)?,
            epoch,
            issued_at_millis,
            expires_at_millis,
        })
    }

    pub fn valid_at(&self, now_millis: u64) -> bool {
        now_millis >= self.issued_at_millis && now_millis < self.expires_at_millis
    }

    fn assert_presented(&self, presented: &Self, now_millis: u64) -> Result<(), AttemptError> {
        if self != presented {
            return Err(AttemptError::new(
                "stale_lease_fence",
                ErrorKind::StaleLeaseFence,
                "presented lease fence does not own this attempt",
            ));
        }
        if !self.valid_at(now_millis) {
            return Err(AttemptError::new(
                "lease_expired",
                ErrorKind::LeaseExpired,
                "attempt lease is not valid at the supplied time",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Pristine,
    Executing,
    WaitingForNetwork,
    WaitingForRetry,
    Succeeded,
    Terminal,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackoffDelay {
    pub retry_number: u8,
    pub base_seconds: u64,
    pub jitter_millis: u64,
    pub delay_millis: u64,
}

pub fn network_backoff_seconds(retry_number: u8) -> Option<u64> {
    retry_number
        .checked_sub(1)
        .and_then(|index| NETWORK_BACKOFF_SECONDS.get(index as usize).copied())
}

/// Produce stable positive jitter without depending on a clock or random source.
///
/// The input seed belongs to the caller's durable request context. Jitter is capped at 25% of
/// the frozen delay, so retry timing stays bounded and a replay receives the same schedule.
pub fn deterministic_jitter_millis(retry_number: u8, seed: u64) -> Result<u64, AttemptError> {
    let base_seconds = network_backoff_seconds(retry_number)
        .ok_or_else(|| AttemptError::invalid("retry number is outside the backoff schedule"))?;
    let bound = base_seconds * 1_000 * MAX_JITTER_PERCENT / 100;
    Ok(splitmix64(seed ^ u64::from(retry_number)) % (bound + 1))
}

impl BackoffDelay {
    pub fn for_retry(retry_number: u8, jitter_seed: Option<u64>) -> Result<Self, AttemptError> {
        let base_seconds = network_backoff_seconds(retry_number)
            .ok_or_else(|| AttemptError::invalid("retry number is outside the backoff schedule"))?;
        let jitter_millis = match jitter_seed {
            Some(seed) => deterministic_jitter_millis(retry_number, seed)?,
            None => 0,
        };
        let delay_millis = base_seconds
            .checked_mul(1_000)
            .and_then(|base| base.checked_add(jitter_millis))
            .ok_or_else(|| AttemptError::invalid("retry delay overflow"))?;
        Ok(Self {
            retry_number,
            base_seconds,
            jitter_millis,
            delay_millis,
        })
    }
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportFailure {
    Dns,
    ConnectionRefused,
    ConnectionReset,
    Timeout,
    Tls,
    BodyInterrupted,
}

impl TransportFailure {
    fn code(self) -> &'static str {
        match self {
            Self::Dns => "transport_dns",
            Self::ConnectionRefused => "transport_connection_refused",
            Self::ConnectionReset => "transport_connection_reset",
            Self::Timeout => "transport_timeout",
            Self::Tls => "transport_tls",
            Self::BodyInterrupted => "transport_body_interrupted",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClassification {
    Transport,
    Server5xx,
    Credential,
    Quota,
    Ambiguous,
    NonRetryable,
}

impl FailureClassification {
    pub fn retryable(self) -> bool {
        matches!(self, Self::Transport | Self::Server5xx)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Failure {
    Transport {
        reason: TransportFailure,
        code: String,
        summary: String,
    },
    Credential {
        code: String,
        summary: String,
    },
    Quota {
        code: String,
        summary: String,
    },
    Server5xx {
        status: u16,
        code: String,
        summary: String,
    },
    Ambiguous {
        code: String,
        summary: String,
    },
    NonRetryable {
        code: String,
        summary: String,
    },
}

impl Failure {
    pub fn transport(
        reason: TransportFailure,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::Transport {
            reason,
            code: reason.code().to_owned(),
            summary: bounded_string(summary, "failure_summary", 4 * 1024)?,
        })
    }

    pub fn credential(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::Credential {
            code: bounded_string(code, "failure_code", 128)?,
            summary: bounded_string(summary, "failure_summary", 4 * 1024)?,
        })
    }

    pub fn quota(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::Quota {
            code: bounded_string(code, "failure_code", 128)?,
            summary: bounded_string(summary, "failure_summary", 4 * 1024)?,
        })
    }

    pub fn server_5xx(status: u16, summary: impl Into<String>) -> Result<Self, AttemptError> {
        if !(500..=599).contains(&status) {
            return Err(AttemptError::invalid(
                "server failure status must be 500..=599",
            ));
        }
        Ok(Self::Server5xx {
            status,
            code: "http_5xx".to_owned(),
            summary: bounded_string(summary, "failure_summary", 4 * 1024)?,
        })
    }

    pub fn ambiguous(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::Ambiguous {
            code: bounded_string(code, "failure_code", 128)?,
            summary: bounded_string(summary, "failure_summary", 4 * 1024)?,
        })
    }

    pub fn non_retryable(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::NonRetryable {
            code: bounded_string(code, "failure_code", 128)?,
            summary: bounded_string(summary, "failure_summary", 4 * 1024)?,
        })
    }

    pub fn classification(&self) -> FailureClassification {
        match self {
            Self::Transport { .. } => FailureClassification::Transport,
            Self::Credential { .. } => FailureClassification::Credential,
            Self::Quota { .. } => FailureClassification::Quota,
            Self::Server5xx { .. } => FailureClassification::Server5xx,
            Self::Ambiguous { .. } => FailureClassification::Ambiguous,
            Self::NonRetryable { .. } => FailureClassification::NonRetryable,
        }
    }

    pub fn code(&self) -> &str {
        match self {
            Self::Transport { code, .. }
            | Self::Credential { code, .. }
            | Self::Quota { code, .. }
            | Self::Server5xx { code, .. }
            | Self::Ambiguous { code, .. }
            | Self::NonRetryable { code, .. } => code,
        }
    }

    pub fn summary(&self) -> &str {
        match self {
            Self::Transport { summary, .. }
            | Self::Credential { summary, .. }
            | Self::Quota { summary, .. }
            | Self::Server5xx { summary, .. }
            | Self::Ambiguous { summary, .. }
            | Self::NonRetryable { summary, .. } => summary,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryDecision {
    ResumeSameSession,
    FreshIfPristine,
    FailClosed,
}

impl RecoveryDecision {
    pub fn code(self) -> &'static str {
        match self {
            Self::ResumeSameSession => "resume_same_session",
            Self::FreshIfPristine => "fresh_if_pristine",
            Self::FailClosed => "fail_closed",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationReason {
    Operator,
    Shutdown,
    Timeout,
    LeaseLost,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationState {
    NotRequested,
    Requested(CancellationReason),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalOutcome {
    Succeeded {
        attempt: AttemptIdentity,
    },
    Cancelled {
        attempt: AttemptIdentity,
        reason: CancellationReason,
    },
    Failed {
        attempt: AttemptIdentity,
        failure: Failure,
    },
    NetworkRetryExhausted {
        attempt: AttemptIdentity,
        failure: Failure,
    },
    NetworkResumeUnsafe {
        attempt: AttemptIdentity,
        failure: Failure,
    },
}

impl TerminalOutcome {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Succeeded { .. } => "succeeded",
            Self::Cancelled { .. } => "cancelled",
            Self::Failed { .. } => "failed",
            Self::NetworkRetryExhausted { .. } => "network_retry_exhausted",
            Self::NetworkResumeUnsafe { .. } => "network_resume_unsafe",
        }
    }

    pub fn failure(&self) -> Option<&Failure> {
        match self {
            Self::Failed { failure, .. }
            | Self::NetworkRetryExhausted { failure, .. }
            | Self::NetworkResumeUnsafe { failure, .. } => Some(failure),
            Self::Succeeded { .. } | Self::Cancelled { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPlan {
    pub failed_attempt: AttemptIdentity,
    pub next_attempt: AttemptIdentity,
    pub classification: FailureClassification,
    pub decision: RecoveryDecision,
    pub backoff: BackoffDelay,
    pub next_attempt_at_millis: u64,
    pub failure: Failure,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryResult {
    RetryScheduled(RecoveryPlan),
    Terminal(TerminalOutcome),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckpoint {
    pub session_id: String,
    pub pristine: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub protocol_version: u16,
    pub identity: HeartbeatIdentity,
    pub attempt: AttemptIdentity,
    pub phase: Phase,
    pub session: SessionCheckpoint,
    pub lease: LeaseFence,
    pub idempotency_key: IdempotencyKey,
    pub request_fingerprint: String,
    pub revision: u64,
    pub cancellation: CancellationState,
    pub last_failure: Option<Failure>,
    pub recovery: Option<RecoveryPlan>,
    pub terminal_outcome: Option<TerminalOutcome>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(value: impl Into<String>) -> Result<Self, AttemptError> {
        Ok(Self(bounded_string(
            value,
            "idempotency_key",
            MAX_ID_BYTES,
        )?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<IdempotencyKey> for String {
    fn from(value: IdempotencyKey) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyRecord {
    pub organization_id: String,
    pub key: IdempotencyKey,
    pub fingerprint: String,
    pub run_id: String,
    pub outcome: Option<TerminalOutcome>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyDecision {
    New,
    Replay { run_id: String },
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct IdempotencyLedger {
    records: BTreeMap<(String, IdempotencyKey), IdempotencyRecord>,
}

impl IdempotencyLedger {
    pub fn reserve(
        &mut self,
        organization_id: impl Into<String>,
        key: IdempotencyKey,
        fingerprint: impl Into<String>,
        run_id: impl Into<String>,
    ) -> Result<IdempotencyDecision, AttemptError> {
        let organization_id = bounded_string(organization_id, "organization_id", MAX_ID_BYTES)?;
        let fingerprint = bounded_string(fingerprint, "request_fingerprint", 4 * 1024)?;
        let run_id = bounded_string(run_id, "run_id", MAX_ID_BYTES)?;
        let index = (organization_id.clone(), key.clone());
        if let Some(existing) = self.records.get(&index) {
            if existing.fingerprint == fingerprint {
                return Ok(IdempotencyDecision::Replay {
                    run_id: existing.run_id.clone(),
                });
            }
            return Err(AttemptError::new(
                "idempotency_conflict",
                ErrorKind::IdempotencyConflict,
                "idempotency key was reused with a different fingerprint",
            ));
        }
        self.records.insert(
            index,
            IdempotencyRecord {
                organization_id,
                key,
                fingerprint,
                run_id,
                outcome: None,
            },
        );
        Ok(IdempotencyDecision::New)
    }

    pub fn record_outcome(
        &mut self,
        organization_id: impl Into<String>,
        key: IdempotencyKey,
        outcome: TerminalOutcome,
    ) -> Result<(), AttemptError> {
        let organization_id = bounded_string(organization_id, "organization_id", MAX_ID_BYTES)?;
        let record = self
            .records
            .get_mut(&(organization_id, key))
            .ok_or_else(|| {
                AttemptError::new(
                    "idempotency_missing",
                    ErrorKind::InvalidInput,
                    "idempotency key has not been reserved",
                )
            })?;
        if let Some(existing) = &record.outcome {
            if existing != &outcome {
                return Err(AttemptError::new(
                    "idempotency_conflict",
                    ErrorKind::IdempotencyConflict,
                    "idempotency key already has a different terminal outcome",
                ));
            }
            return Ok(());
        }
        record.outcome = Some(outcome);
        Ok(())
    }

    pub fn outcome(
        &self,
        organization_id: impl AsRef<str>,
        key: &IdempotencyKey,
    ) -> Option<&TerminalOutcome> {
        self.records
            .get(&(organization_id.as_ref().to_owned(), key.clone()))
            .and_then(|record| record.outcome.as_ref())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptMachine {
    identity: HeartbeatIdentity,
    attempt: u8,
    phase: Phase,
    session: SessionCheckpoint,
    lease: LeaseFence,
    idempotency_key: IdempotencyKey,
    request_fingerprint: String,
    revision: u64,
    cancellation: CancellationState,
    last_failure: Option<Failure>,
    recovery: Option<RecoveryPlan>,
    terminal_outcome: Option<TerminalOutcome>,
}

impl AttemptMachine {
    pub fn new(
        identity: HeartbeatIdentity,
        session_id: impl Into<String>,
        lease: LeaseFence,
        idempotency_key: impl Into<String>,
        request_fingerprint: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self {
            identity,
            attempt: 1,
            phase: Phase::Pristine,
            session: SessionCheckpoint {
                session_id: bounded_string(session_id, "session_id", MAX_ID_BYTES)?,
                pristine: true,
            },
            lease,
            idempotency_key: IdempotencyKey::new(idempotency_key)?,
            request_fingerprint: bounded_string(
                request_fingerprint,
                "request_fingerprint",
                4 * 1024,
            )?,
            revision: 0,
            cancellation: CancellationState::NotRequested,
            last_failure: None,
            recovery: None,
            terminal_outcome: None,
        })
    }

    pub fn from_checkpoint(checkpoint: Checkpoint) -> Result<Self, AttemptError> {
        if checkpoint.protocol_version != ATTEMPT_PROTOCOL_VERSION {
            return Err(AttemptError::invalid(
                "unsupported checkpoint protocol version",
            ));
        }
        if checkpoint.identity != checkpoint.attempt.heartbeat_identity()
            || checkpoint.attempt.attempt == 0
            || checkpoint.attempt.attempt > MAX_ATTEMPTS
        {
            return Err(AttemptError::invalid(
                "checkpoint identity and attempt do not agree",
            ));
        }
        let request_fingerprint = bounded_string(
            checkpoint.request_fingerprint.clone(),
            "request_fingerprint",
            4 * 1024,
        )?;
        let session_id = bounded_string(
            checkpoint.session.session_id.clone(),
            "session_id",
            MAX_ID_BYTES,
        )?;
        Ok(Self {
            identity: checkpoint.identity,
            attempt: checkpoint.attempt.attempt,
            phase: checkpoint.phase,
            session: SessionCheckpoint {
                session_id,
                pristine: checkpoint.session.pristine,
            },
            lease: checkpoint.lease,
            idempotency_key: checkpoint.idempotency_key,
            request_fingerprint,
            revision: checkpoint.revision,
            cancellation: checkpoint.cancellation,
            last_failure: checkpoint.last_failure,
            recovery: checkpoint.recovery,
            terminal_outcome: checkpoint.terminal_outcome,
        })
    }

    pub fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            protocol_version: ATTEMPT_PROTOCOL_VERSION,
            identity: self.identity.clone(),
            attempt: self.attempt_identity(),
            phase: self.phase,
            session: self.session.clone(),
            lease: self.lease.clone(),
            idempotency_key: self.idempotency_key.clone(),
            request_fingerprint: self.request_fingerprint.clone(),
            revision: self.revision,
            cancellation: self.cancellation,
            last_failure: self.last_failure.clone(),
            recovery: self.recovery.clone(),
            terminal_outcome: self.terminal_outcome.clone(),
        }
    }

    pub fn identity(&self) -> &HeartbeatIdentity {
        &self.identity
    }

    pub fn attempt_identity(&self) -> AttemptIdentity {
        self.identity
            .attempt(self.attempt)
            .expect("machine invariants keep attempt within the hard bound")
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn session_id(&self) -> &str {
        &self.session.session_id
    }

    pub fn session_pristine(&self) -> bool {
        self.session.pristine
    }

    pub fn cancellation(&self) -> CancellationState {
        self.cancellation
    }

    pub fn terminal_outcome(&self) -> Option<&TerminalOutcome> {
        self.terminal_outcome.as_ref()
    }

    pub fn recovery_plan(&self) -> Option<&RecoveryPlan> {
        self.recovery.as_ref()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    fn bump_revision(&mut self) -> Result<(), AttemptError> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| AttemptError::invalid("checkpoint revision overflow"))?;
        Ok(())
    }

    fn ensure_not_cancelled(&self) -> Result<(), AttemptError> {
        if let CancellationState::Requested(reason) = self.cancellation {
            return Err(AttemptError::new(
                "cancellation_requested",
                ErrorKind::CancellationRequested,
                format!("attempt cancellation was requested: {reason:?}"),
            ));
        }
        Ok(())
    }

    pub fn start(
        &mut self,
        fence: &LeaseFence,
        now_millis: u64,
    ) -> Result<AttemptIdentity, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        self.ensure_not_cancelled()?;
        match self.phase {
            Phase::Pristine => {
                self.bump_revision()?;
                self.phase = Phase::Executing;
                Ok(self.attempt_identity())
            }
            Phase::Executing => Ok(self.attempt_identity()),
            Phase::Terminal | Phase::Succeeded => Err(AttemptError::new(
                "already_terminal",
                ErrorKind::AlreadyTerminal,
                "attempt machine is already terminal",
            )),
            _ => Err(AttemptError::new(
                "invalid_transition",
                ErrorKind::InvalidTransition,
                "attempt cannot start from its current phase",
            )),
        }
    }

    /// Persist the boundary at which an in-flight network operation is being observed.
    pub fn mark_waiting_for_network(
        &mut self,
        fence: &LeaseFence,
        now_millis: u64,
    ) -> Result<Checkpoint, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        self.ensure_not_cancelled()?;
        match self.phase {
            Phase::Executing => {
                self.bump_revision()?;
                self.phase = Phase::WaitingForNetwork;
                Ok(self.checkpoint())
            }
            Phase::WaitingForNetwork => Ok(self.checkpoint()),
            _ => Err(AttemptError::new(
                "invalid_transition",
                ErrorKind::InvalidTransition,
                "network wait can only begin while executing",
            )),
        }
    }

    /// Record a durable progress marker. A non-pristine session may be resumed, but it must not
    /// be replaced with a fresh session after a network failure.
    pub fn checkpoint_progress(
        &mut self,
        fence: &LeaseFence,
        now_millis: u64,
    ) -> Result<Checkpoint, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        self.ensure_not_cancelled()?;
        match self.phase {
            Phase::Executing | Phase::WaitingForNetwork if self.session.pristine => {
                self.bump_revision()?;
                self.session.pristine = false;
                Ok(self.checkpoint())
            }
            Phase::Executing | Phase::WaitingForNetwork => Ok(self.checkpoint()),
            _ => Err(AttemptError::new(
                "invalid_transition",
                ErrorKind::InvalidTransition,
                "progress can only be checkpointed while executing",
            )),
        }
    }

    fn install_terminal(
        &mut self,
        outcome: TerminalOutcome,
        failure: Option<Failure>,
    ) -> Result<RecoveryResult, AttemptError> {
        self.bump_revision()?;
        self.phase = Phase::Terminal;
        self.last_failure = failure;
        self.recovery = None;
        self.terminal_outcome = Some(outcome.clone());
        Ok(RecoveryResult::Terminal(outcome))
    }

    fn install_success(&mut self) -> Result<TerminalOutcome, AttemptError> {
        self.bump_revision()?;
        self.phase = Phase::Succeeded;
        self.last_failure = None;
        self.recovery = None;
        let outcome = TerminalOutcome::Succeeded {
            attempt: self.attempt_identity(),
        };
        self.terminal_outcome = Some(outcome.clone());
        Ok(outcome)
    }

    pub fn succeed(
        &mut self,
        fence: &LeaseFence,
        now_millis: u64,
    ) -> Result<TerminalOutcome, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        if let Some(TerminalOutcome::Succeeded { .. }) = &self.terminal_outcome {
            return self.terminal_outcome.clone().ok_or_else(|| {
                AttemptError::new(
                    "checkpoint_invalid",
                    ErrorKind::CheckpointInvalid,
                    "successful phase has no outcome",
                )
            });
        }
        self.ensure_not_cancelled()?;
        if self.phase == Phase::Terminal || self.phase == Phase::Succeeded {
            return Err(AttemptError::new(
                "already_terminal",
                ErrorKind::AlreadyTerminal,
                "attempt machine is already terminal",
            ));
        }
        if !matches!(self.phase, Phase::Executing | Phase::WaitingForNetwork) {
            return Err(AttemptError::new(
                "invalid_transition",
                ErrorKind::InvalidTransition,
                "success can only be recorded for an executing attempt",
            ));
        }
        self.install_success()
    }

    /// Classify a transport/provider result and return a side-effect-free recovery plan.
    pub fn record_failure(
        &mut self,
        failure: Failure,
        fence: &LeaseFence,
        now_millis: u64,
        jitter_seed: Option<u64>,
    ) -> Result<RecoveryResult, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        self.ensure_not_cancelled()?;

        if self.phase == Phase::WaitingForRetry {
            if self.last_failure.as_ref() == Some(&failure) {
                return self
                    .recovery
                    .clone()
                    .map(RecoveryResult::RetryScheduled)
                    .ok_or_else(|| {
                        AttemptError::new(
                            "checkpoint_invalid",
                            ErrorKind::CheckpointInvalid,
                            "retry phase has no recovery plan",
                        )
                    });
            }
            return Err(AttemptError::new(
                "idempotency_conflict",
                ErrorKind::IdempotencyConflict,
                "a different failure was replayed for the same attempt",
            ));
        }
        if self.phase == Phase::Terminal {
            if self
                .terminal_outcome
                .as_ref()
                .and_then(TerminalOutcome::failure)
                == Some(&failure)
            {
                return self
                    .terminal_outcome
                    .clone()
                    .map(RecoveryResult::Terminal)
                    .ok_or_else(|| {
                        AttemptError::new(
                            "checkpoint_invalid",
                            ErrorKind::CheckpointInvalid,
                            "terminal phase has no outcome",
                        )
                    });
            }
            return Err(AttemptError::new(
                "already_terminal",
                ErrorKind::AlreadyTerminal,
                "attempt machine is already terminal",
            ));
        }
        if !matches!(self.phase, Phase::Executing | Phase::WaitingForNetwork) {
            return Err(AttemptError::new(
                "invalid_transition",
                ErrorKind::InvalidTransition,
                "failure can only be recorded for an executing attempt",
            ));
        }

        let classification = failure.classification();
        let current_attempt = self.attempt_identity();
        if classification == FailureClassification::Ambiguous {
            let outcome = TerminalOutcome::NetworkResumeUnsafe {
                attempt: current_attempt,
                failure: failure.clone(),
            };
            return self.install_terminal(outcome, Some(failure));
        }
        if !classification.retryable() {
            let outcome = TerminalOutcome::Failed {
                attempt: current_attempt,
                failure: failure.clone(),
            };
            return self.install_terminal(outcome, Some(failure));
        }
        if self.attempt >= MAX_ATTEMPTS {
            let outcome = TerminalOutcome::NetworkRetryExhausted {
                attempt: current_attempt,
                failure: failure.clone(),
            };
            return self.install_terminal(outcome, Some(failure));
        }

        let retry_number = self.attempt;
        let backoff = BackoffDelay::for_retry(retry_number, jitter_seed)?;
        let next_attempt_at_millis = now_millis
            .checked_add(backoff.delay_millis)
            .ok_or_else(|| AttemptError::invalid("retry timestamp overflow"))?;
        let next_attempt = self.identity.attempt(self.attempt + 1)?;
        let decision = if self.session.pristine {
            RecoveryDecision::FreshIfPristine
        } else {
            RecoveryDecision::ResumeSameSession
        };
        let plan = RecoveryPlan {
            failed_attempt: current_attempt,
            next_attempt,
            classification,
            decision,
            backoff,
            next_attempt_at_millis,
            failure: failure.clone(),
        };
        self.bump_revision()?;
        self.phase = Phase::WaitingForRetry;
        self.last_failure = Some(failure);
        self.recovery = Some(plan.clone());
        Ok(RecoveryResult::RetryScheduled(plan))
    }

    fn recover(
        &mut self,
        decision: RecoveryDecision,
        fence: &LeaseFence,
        now_millis: u64,
        fresh_session_id: Option<String>,
    ) -> Result<AttemptIdentity, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        self.ensure_not_cancelled()?;
        if self.phase == Phase::Executing
            && self
                .recovery
                .as_ref()
                .is_some_and(|plan| plan.decision == decision)
        {
            return Ok(self.attempt_identity());
        }
        if self.phase != Phase::WaitingForRetry {
            return Err(AttemptError::new(
                "invalid_transition",
                ErrorKind::InvalidTransition,
                "recovery requires a scheduled retry",
            ));
        }
        let plan = self.recovery.clone().ok_or_else(|| {
            AttemptError::new(
                "checkpoint_invalid",
                ErrorKind::CheckpointInvalid,
                "retry phase has no recovery plan",
            )
        })?;
        if now_millis < plan.next_attempt_at_millis {
            return Err(AttemptError::new(
                "retry_not_due",
                ErrorKind::RetryNotDue,
                "retry cannot resume before its scheduled time",
            ));
        }
        if plan.decision != decision {
            return Err(AttemptError::new(
                "recovery_choice_mismatch",
                ErrorKind::RecoveryChoiceMismatch,
                format!("recovery requires {}", plan.decision.code()),
            ));
        }
        if decision == RecoveryDecision::FreshIfPristine {
            if !self.session.pristine {
                return Err(AttemptError::new(
                    "recovery_choice_mismatch",
                    ErrorKind::RecoveryChoiceMismatch,
                    "a non-pristine session cannot be replaced",
                ));
            }
            let session_id = fresh_session_id.ok_or_else(|| {
                AttemptError::invalid("fresh_if_pristine requires a new session id")
            })?;
            self.session.session_id = bounded_string(session_id, "session_id", MAX_ID_BYTES)?;
        } else if fresh_session_id.is_some() {
            return Err(AttemptError::new(
                "recovery_choice_mismatch",
                ErrorKind::RecoveryChoiceMismatch,
                "resume_same_session cannot accept a replacement session",
            ));
        }
        self.bump_revision()?;
        self.attempt = plan.next_attempt.attempt;
        self.phase = Phase::Executing;
        Ok(self.attempt_identity())
    }

    pub fn resume_same_session(
        &mut self,
        fence: &LeaseFence,
        now_millis: u64,
    ) -> Result<AttemptIdentity, AttemptError> {
        self.recover(RecoveryDecision::ResumeSameSession, fence, now_millis, None)
    }

    pub fn fail_closed(
        &mut self,
        fence: &LeaseFence,
        now_millis: u64,
    ) -> Result<TerminalOutcome, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        if let Some(TerminalOutcome::NetworkResumeUnsafe { .. }) = &self.terminal_outcome {
            return self.terminal_outcome.clone().ok_or_else(|| {
                AttemptError::new(
                    "checkpoint_invalid",
                    ErrorKind::CheckpointInvalid,
                    "unsafe terminal phase has no outcome",
                )
            });
        }
        self.ensure_not_cancelled()?;
        let failure = match self.phase {
            Phase::WaitingForRetry => self
                .recovery
                .as_ref()
                .map(|plan| plan.failure.clone())
                .or_else(|| self.last_failure.clone()),
            Phase::Executing | Phase::WaitingForNetwork => self.last_failure.clone(),
            Phase::Terminal | Phase::Succeeded => None,
            Phase::Pristine => None,
        }
        .ok_or_else(|| {
            AttemptError::new(
                "invalid_transition",
                ErrorKind::InvalidTransition,
                "fail_closed requires a recorded network failure",
            )
        })?;
        let outcome = TerminalOutcome::NetworkResumeUnsafe {
            attempt: self.attempt_identity(),
            failure: failure.clone(),
        };
        match self.install_terminal(outcome, Some(failure))? {
            RecoveryResult::Terminal(outcome) => Ok(outcome),
            RecoveryResult::RetryScheduled(_) => Err(AttemptError::invalid(
                "fail_closed unexpectedly scheduled a retry",
            )),
        }
    }

    pub fn cancel(
        &mut self,
        fence: &LeaseFence,
        reason: CancellationReason,
        now_millis: u64,
    ) -> Result<TerminalOutcome, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        let already_cancelled = matches!(
            &self.terminal_outcome,
            Some(TerminalOutcome::Cancelled {
                reason: existing_reason,
                ..
            }) if *existing_reason == reason
        );
        if already_cancelled {
            return self.terminal_outcome.clone().ok_or_else(|| {
                AttemptError::new(
                    "checkpoint_invalid",
                    ErrorKind::CheckpointInvalid,
                    "cancelled phase has no outcome",
                )
            });
        }
        if self.phase == Phase::Terminal || self.phase == Phase::Succeeded {
            return Err(AttemptError::new(
                "already_terminal",
                ErrorKind::AlreadyTerminal,
                "attempt machine is already terminal",
            ));
        }
        self.bump_revision()?;
        self.cancellation = CancellationState::Requested(reason);
        let outcome = TerminalOutcome::Cancelled {
            attempt: self.attempt_identity(),
            reason,
        };
        self.phase = Phase::Terminal;
        self.recovery = None;
        self.terminal_outcome = Some(outcome.clone());
        Ok(outcome)
    }

    pub fn fresh_if_pristine(
        &mut self,
        fence: &LeaseFence,
        now_millis: u64,
        fresh_session_id: impl Into<String>,
    ) -> Result<AttemptIdentity, AttemptError> {
        self.recover(
            RecoveryDecision::FreshIfPristine,
            fence,
            now_millis,
            Some(fresh_session_id.into()),
        )
    }
}
