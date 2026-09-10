//! Pure, bounded heartbeat attempt and network-recovery state.
//!
//! The crate contains only data validation and deterministic state transitions. It deliberately
//! does not perform network, database, process, clock, or sleep operations; an adapter can carry
//! the returned checkpoint and recovery plan to the current runtime authority.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use std::borrow::Borrow;
use std::fmt;

pub const ATTEMPT_PROTOCOL_VERSION: u16 = 1;
/// The initial attempt plus one attempt for each bounded network wait.
pub const MAX_NETWORK_WAITS: u8 = 6;
pub const MAX_ATTEMPTS: u8 = MAX_NETWORK_WAITS + 1;
pub const MAX_ID_BYTES: usize = 255;
pub const MAX_REQUEST_FINGERPRINT_BYTES: usize = 4 * 1024;
pub const MAX_FAILURE_CODE_BYTES: usize = 128;
pub const MAX_FAILURE_SUMMARY_BYTES: usize = 4 * 1024;
pub const MAX_IDEMPOTENCY_RECORDS: usize = 1_024;
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

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
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

    fn validate(&self) -> Result<(), AttemptError> {
        bounded_string(
            self.organization_id.clone(),
            "organization_id",
            MAX_ID_BYTES,
        )?;
        bounded_string(self.run_id.clone(), "run_id", MAX_ID_BYTES)?;
        bounded_string(self.agent_id.clone(), "agent_id", MAX_ID_BYTES)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
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

    fn validate(&self) -> Result<(), AttemptError> {
        self.heartbeat_identity().validate()?;
        if !(1..=MAX_ATTEMPTS).contains(&self.attempt) {
            return Err(AttemptError::invalid(format!(
                "attempt must be between 1 and {MAX_ATTEMPTS}"
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
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
        self.epoch > 0
            && !self.owner_id.trim().is_empty()
            && self.owner_id.len() <= MAX_ID_BYTES
            && self.expires_at_millis > self.issued_at_millis
            && now_millis >= self.issued_at_millis
            && now_millis < self.expires_at_millis
    }

    fn validate(&self) -> Result<(), AttemptError> {
        Self::new(
            self.owner_id.clone(),
            self.epoch,
            self.issued_at_millis,
            self.expires_at_millis,
        )
        .map(|_| ())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeartbeatIdentityWire {
    organization_id: String,
    run_id: String,
    agent_id: String,
}

impl<'de> Deserialize<'de> for HeartbeatIdentity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = HeartbeatIdentityWire::deserialize(deserializer)?;
        Self::new(wire.organization_id, wire.run_id, wire.agent_id).map_err(de::Error::custom)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttemptIdentityWire {
    organization_id: String,
    run_id: String,
    agent_id: String,
    attempt: u8,
}

impl<'de> Deserialize<'de> for AttemptIdentity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = AttemptIdentityWire::deserialize(deserializer)?;
        Self::new(
            wire.organization_id,
            wire.run_id,
            wire.agent_id,
            wire.attempt,
        )
        .map_err(de::Error::custom)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseFenceWire {
    owner_id: String,
    epoch: u64,
    issued_at_millis: u64,
    expires_at_millis: u64,
}

impl<'de> Deserialize<'de> for LeaseFence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = LeaseFenceWire::deserialize(deserializer)?;
        Self::new(
            wire.owner_id,
            wire.epoch,
            wire.issued_at_millis,
            wire.expires_at_millis,
        )
        .map_err(de::Error::custom)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
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

    fn validate(&self) -> Result<(), AttemptError> {
        let expected_base = network_backoff_seconds(self.retry_number)
            .ok_or_else(|| AttemptError::invalid("retry number is outside the backoff schedule"))?;
        let jitter_bound = expected_base
            .checked_mul(1_000)
            .and_then(|millis| millis.checked_mul(MAX_JITTER_PERCENT))
            .map(|millis| millis / 100)
            .ok_or_else(|| AttemptError::invalid("retry jitter overflow"))?;
        if self.base_seconds != expected_base {
            return Err(AttemptError::invalid(
                "backoff base does not match its retry number",
            ));
        }
        if self.jitter_millis > jitter_bound {
            return Err(AttemptError::invalid("backoff jitter exceeds its bound"));
        }
        let expected_delay = expected_base
            .checked_mul(1_000)
            .and_then(|millis| millis.checked_add(self.jitter_millis))
            .ok_or_else(|| AttemptError::invalid("retry delay overflow"))?;
        if self.delay_millis != expected_delay {
            return Err(AttemptError::invalid(
                "backoff delay does not match its components",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackoffDelayWire {
    retry_number: u8,
    base_seconds: u64,
    jitter_millis: u64,
    delay_millis: u64,
}

impl<'de> Deserialize<'de> for BackoffDelay {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = BackoffDelayWire::deserialize(deserializer)?;
        let delay = Self {
            retry_number: wire.retry_number,
            base_seconds: wire.base_seconds,
            jitter_millis: wire.jitter_millis,
            delay_millis: wire.delay_millis,
        };
        delay.validate().map(|_| delay).map_err(de::Error::custom)
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
    /// Returns the retryable class, not the final decision for a concrete failure.
    ///
    /// Transport failures still require [`Failure::retryable`] because TLS transport failures are
    /// terminal under the conservative recovery contract.
    pub fn retryable(self) -> bool {
        matches!(self, Self::Transport)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
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
            summary: bounded_string(summary, "failure_summary", MAX_FAILURE_SUMMARY_BYTES)?,
        })
    }

    pub fn credential(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::Credential {
            code: bounded_string(code, "failure_code", MAX_FAILURE_CODE_BYTES)?,
            summary: bounded_string(summary, "failure_summary", MAX_FAILURE_SUMMARY_BYTES)?,
        })
    }

    pub fn quota(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::Quota {
            code: bounded_string(code, "failure_code", MAX_FAILURE_CODE_BYTES)?,
            summary: bounded_string(summary, "failure_summary", MAX_FAILURE_SUMMARY_BYTES)?,
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
            summary: bounded_string(summary, "failure_summary", MAX_FAILURE_SUMMARY_BYTES)?,
        })
    }

    pub fn ambiguous(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::Ambiguous {
            code: bounded_string(code, "failure_code", MAX_FAILURE_CODE_BYTES)?,
            summary: bounded_string(summary, "failure_summary", MAX_FAILURE_SUMMARY_BYTES)?,
        })
    }

    pub fn non_retryable(
        code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        Ok(Self::NonRetryable {
            code: bounded_string(code, "failure_code", MAX_FAILURE_CODE_BYTES)?,
            summary: bounded_string(summary, "failure_summary", MAX_FAILURE_SUMMARY_BYTES)?,
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

    /// Only failures whose outcome is safe to retry may create a network wait.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Transport {
                reason: TransportFailure::Dns
                    | TransportFailure::ConnectionRefused
                    | TransportFailure::ConnectionReset
                    | TransportFailure::Timeout
                    | TransportFailure::BodyInterrupted,
                ..
            }
        )
    }

    fn validate(&self) -> Result<(), AttemptError> {
        match self {
            Self::Transport {
                reason,
                code,
                summary,
            } => {
                if code != reason.code() {
                    return Err(AttemptError::invalid(
                        "transport failure code does not match its reason",
                    ));
                }
                bounded_string(
                    summary.clone(),
                    "failure_summary",
                    MAX_FAILURE_SUMMARY_BYTES,
                )?;
            }
            Self::Credential { code, summary }
            | Self::Quota { code, summary }
            | Self::Ambiguous { code, summary }
            | Self::NonRetryable { code, summary } => {
                bounded_string(code.clone(), "failure_code", MAX_FAILURE_CODE_BYTES)?;
                bounded_string(
                    summary.clone(),
                    "failure_summary",
                    MAX_FAILURE_SUMMARY_BYTES,
                )?;
            }
            Self::Server5xx {
                status,
                code,
                summary,
            } => {
                if !(500..=599).contains(status) || code != "http_5xx" {
                    return Err(AttemptError::invalid(
                        "server failure has an invalid status or code",
                    ));
                }
                bounded_string(
                    summary.clone(),
                    "failure_summary",
                    MAX_FAILURE_SUMMARY_BYTES,
                )?;
            }
        }
        Ok(())
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

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum FailureWire {
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

impl<'de> Deserialize<'de> for Failure {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let failure = match FailureWire::deserialize(deserializer)? {
            FailureWire::Transport {
                reason,
                code,
                summary,
            } => Self::Transport {
                reason,
                code,
                summary,
            },
            FailureWire::Credential { code, summary } => Self::Credential { code, summary },
            FailureWire::Quota { code, summary } => Self::Quota { code, summary },
            FailureWire::Server5xx {
                status,
                code,
                summary,
            } => Self::Server5xx {
                status,
                code,
                summary,
            },
            FailureWire::Ambiguous { code, summary } => Self::Ambiguous { code, summary },
            FailureWire::NonRetryable { code, summary } => Self::NonRetryable { code, summary },
        };
        failure
            .validate()
            .map(|_| failure)
            .map_err(de::Error::custom)
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
pub enum SubmissionPhase {
    PreSubmission,
    Accepted,
    Indeterminate,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SideEffectRisk {
    None,
    Possible,
    Confirmed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEvidence {
    pub submission_phase: SubmissionPhase,
    pub side_effect_risk: SideEffectRisk,
    pub model_output_observed: bool,
    pub tool_activity_observed: bool,
    pub terminal_event_observed: bool,
}

impl RecoveryEvidence {
    pub const fn pre_submission() -> Self {
        Self {
            submission_phase: SubmissionPhase::PreSubmission,
            side_effect_risk: SideEffectRisk::None,
            model_output_observed: false,
            tool_activity_observed: false,
            terminal_event_observed: false,
        }
    }

    pub fn new(
        submission_phase: SubmissionPhase,
        side_effect_risk: SideEffectRisk,
        model_output_observed: bool,
        tool_activity_observed: bool,
        terminal_event_observed: bool,
    ) -> Result<Self, AttemptError> {
        let evidence = Self {
            submission_phase,
            side_effect_risk,
            model_output_observed,
            tool_activity_observed,
            terminal_event_observed,
        };
        evidence.validate().map(|_| evidence)
    }

    fn validate(&self) -> Result<(), AttemptError> {
        if self.tool_activity_observed && self.submission_phase != SubmissionPhase::Accepted {
            return Err(AttemptError::invalid(
                "tool activity requires an accepted submission phase",
            ));
        }
        if self.model_output_observed && self.submission_phase != SubmissionPhase::Accepted {
            return Err(AttemptError::invalid(
                "model output requires an accepted submission phase",
            ));
        }
        if self.terminal_event_observed && self.submission_phase == SubmissionPhase::PreSubmission {
            return Err(AttemptError::invalid(
                "terminal event evidence requires a submitted or indeterminate phase",
            ));
        }
        match self.side_effect_risk {
            SideEffectRisk::None => {
                if self.submission_phase != SubmissionPhase::PreSubmission
                    || self.model_output_observed
                    || self.tool_activity_observed
                    || self.terminal_event_observed
                {
                    return Err(AttemptError::invalid(
                        "none side-effect risk requires an untouched submission",
                    ));
                }
            }
            SideEffectRisk::Possible => {
                if self.submission_phase == SubmissionPhase::PreSubmission {
                    return Err(AttemptError::invalid(
                        "pre-submission evidence cannot have possible side effects",
                    ));
                }
            }
            SideEffectRisk::Confirmed => {
                if !self.tool_activity_observed {
                    return Err(AttemptError::invalid(
                        "confirmed side effects require tool activity evidence",
                    ));
                }
            }
        }
        if self.submission_phase == SubmissionPhase::Accepted
            && self.side_effect_risk == SideEffectRisk::None
        {
            return Err(AttemptError::invalid(
                "accepted submission requires side-effect risk evidence",
            ));
        }
        Ok(())
    }

    fn decision(self, session_pristine: bool, has_session: bool) -> RecoveryDecision {
        if !has_session || self.terminal_event_observed {
            return RecoveryDecision::FailClosed;
        }
        match self.submission_phase {
            SubmissionPhase::PreSubmission if session_pristine => RecoveryDecision::FreshIfPristine,
            SubmissionPhase::PreSubmission | SubmissionPhase::Accepted => {
                RecoveryDecision::ResumeSameSession
            }
            SubmissionPhase::Indeterminate => RecoveryDecision::FailClosed,
        }
    }

    fn merge(self, newer: Self) -> Result<Self, AttemptError> {
        newer.validate()?;
        let model_output_observed = self.model_output_observed || newer.model_output_observed;
        let tool_activity_observed = self.tool_activity_observed || newer.tool_activity_observed;
        let terminal_event_observed = self.terminal_event_observed || newer.terminal_event_observed;
        let submission_phase = if model_output_observed
            || tool_activity_observed
            || self.submission_phase == SubmissionPhase::Accepted
            || newer.submission_phase == SubmissionPhase::Accepted
        {
            SubmissionPhase::Accepted
        } else if self.submission_phase == SubmissionPhase::Indeterminate
            || newer.submission_phase == SubmissionPhase::Indeterminate
        {
            SubmissionPhase::Indeterminate
        } else {
            SubmissionPhase::PreSubmission
        };
        let side_effect_risk = if tool_activity_observed {
            SideEffectRisk::Confirmed
        } else if model_output_observed
            || submission_phase != SubmissionPhase::PreSubmission
            || self.side_effect_risk != SideEffectRisk::None
            || newer.side_effect_risk != SideEffectRisk::None
        {
            SideEffectRisk::Possible
        } else {
            SideEffectRisk::None
        };
        Self::new(
            submission_phase,
            side_effect_risk,
            model_output_observed,
            tool_activity_observed,
            terminal_event_observed,
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryEvidenceWire {
    submission_phase: SubmissionPhase,
    side_effect_risk: SideEffectRisk,
    model_output_observed: bool,
    tool_activity_observed: bool,
    terminal_event_observed: bool,
}

impl<'de> Deserialize<'de> for RecoveryEvidence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = RecoveryEvidenceWire::deserialize(deserializer)?;
        Self::new(
            wire.submission_phase,
            wire.side_effect_risk,
            wire.model_output_observed,
            wire.tool_activity_observed,
            wire.terminal_event_observed,
        )
        .map_err(de::Error::custom)
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
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

    pub fn attempt_identity(&self) -> &AttemptIdentity {
        match self {
            Self::Succeeded { attempt }
            | Self::Cancelled { attempt, .. }
            | Self::Failed { attempt, .. }
            | Self::NetworkRetryExhausted { attempt, .. }
            | Self::NetworkResumeUnsafe { attempt, .. } => attempt,
        }
    }

    fn validate(&self) -> Result<(), AttemptError> {
        match self {
            Self::Succeeded { attempt } | Self::Cancelled { attempt, .. } => attempt.validate()?,
            Self::Failed { attempt, failure } => {
                attempt.validate()?;
                failure.validate()?;
                if failure.retryable()
                    || failure.classification() == FailureClassification::Ambiguous
                {
                    return Err(AttemptError::invalid(
                        "retryable or ambiguous failures require a network-safe terminal outcome",
                    ));
                }
            }
            Self::NetworkRetryExhausted { attempt, failure } => {
                attempt.validate()?;
                failure.validate()?;
                if attempt.attempt != MAX_ATTEMPTS || !failure.retryable() {
                    return Err(AttemptError::invalid(
                        "network exhaustion must be the final retryable attempt",
                    ));
                }
            }
            Self::NetworkResumeUnsafe { attempt, failure } => {
                attempt.validate()?;
                failure.validate()?;
                if !failure.retryable()
                    && failure.classification() != FailureClassification::Ambiguous
                {
                    return Err(AttemptError::invalid(
                        "unsafe network recovery requires a retryable or ambiguous failure",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum TerminalOutcomeWire {
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

impl<'de> Deserialize<'de> for TerminalOutcome {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let outcome = match TerminalOutcomeWire::deserialize(deserializer)? {
            TerminalOutcomeWire::Succeeded { attempt } => Self::Succeeded { attempt },
            TerminalOutcomeWire::Cancelled { attempt, reason } => {
                Self::Cancelled { attempt, reason }
            }
            TerminalOutcomeWire::Failed { attempt, failure } => Self::Failed { attempt, failure },
            TerminalOutcomeWire::NetworkRetryExhausted { attempt, failure } => {
                Self::NetworkRetryExhausted { attempt, failure }
            }
            TerminalOutcomeWire::NetworkResumeUnsafe { attempt, failure } => {
                Self::NetworkResumeUnsafe { attempt, failure }
            }
        };
        outcome
            .validate()
            .map(|_| outcome)
            .map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPlan {
    pub failed_attempt: AttemptIdentity,
    pub next_attempt: AttemptIdentity,
    pub classification: FailureClassification,
    pub decision: RecoveryDecision,
    pub backoff: BackoffDelay,
    pub network_wait_number: u8,
    pub next_attempt_at_millis: u64,
    pub failure: Failure,
    pub submission_phase: SubmissionPhase,
    pub side_effect_risk: SideEffectRisk,
    pub model_output_observed: bool,
    pub tool_activity_observed: bool,
    pub terminal_event_observed: bool,
}

impl RecoveryPlan {
    fn evidence(&self) -> RecoveryEvidence {
        RecoveryEvidence {
            submission_phase: self.submission_phase,
            side_effect_risk: self.side_effect_risk,
            model_output_observed: self.model_output_observed,
            tool_activity_observed: self.tool_activity_observed,
            terminal_event_observed: self.terminal_event_observed,
        }
    }

    fn validate(&self) -> Result<(), AttemptError> {
        self.failed_attempt.validate()?;
        self.next_attempt.validate()?;
        if self.failed_attempt.heartbeat_identity() != self.next_attempt.heartbeat_identity()
            || self.next_attempt.attempt != self.failed_attempt.attempt.saturating_add(1)
        {
            return Err(AttemptError::invalid(
                "recovery plan attempt identities do not progress by one",
            ));
        }
        if !(1..=MAX_NETWORK_WAITS).contains(&self.network_wait_number)
            || self.backoff.retry_number != self.network_wait_number
            || self.failed_attempt.attempt != self.network_wait_number
        {
            return Err(AttemptError::invalid(
                "recovery plan has an invalid network wait number",
            ));
        }
        self.backoff.validate()?;
        if self.classification != self.failure.classification() {
            return Err(AttemptError::invalid(
                "recovery plan classification does not match its failure",
            ));
        }
        if !self.failure.retryable() {
            return Err(AttemptError::invalid(
                "non-retryable failures cannot have a recovery plan",
            ));
        }
        let evidence = self.evidence();
        evidence.validate()?;
        if self.decision == RecoveryDecision::FailClosed {
            return Err(AttemptError::invalid(
                "fail-closed recovery must be represented by a terminal outcome",
            ));
        }
        if evidence.terminal_event_observed {
            return Err(AttemptError::invalid(
                "terminal event evidence must fail closed",
            ));
        }
        if self.decision == RecoveryDecision::FreshIfPristine
            && evidence.submission_phase != SubmissionPhase::PreSubmission
        {
            return Err(AttemptError::invalid(
                "fresh recovery requires pre-submission evidence",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryPlanWire {
    failed_attempt: AttemptIdentity,
    next_attempt: AttemptIdentity,
    classification: FailureClassification,
    decision: RecoveryDecision,
    backoff: BackoffDelay,
    network_wait_number: u8,
    next_attempt_at_millis: u64,
    failure: Failure,
    submission_phase: SubmissionPhase,
    side_effect_risk: SideEffectRisk,
    model_output_observed: bool,
    tool_activity_observed: bool,
    terminal_event_observed: bool,
}

impl<'de> Deserialize<'de> for RecoveryPlan {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = RecoveryPlanWire::deserialize(deserializer)?;
        let plan = Self {
            failed_attempt: wire.failed_attempt,
            next_attempt: wire.next_attempt,
            classification: wire.classification,
            decision: wire.decision,
            backoff: wire.backoff,
            network_wait_number: wire.network_wait_number,
            next_attempt_at_millis: wire.next_attempt_at_millis,
            failure: wire.failure,
            submission_phase: wire.submission_phase,
            side_effect_risk: wire.side_effect_risk,
            model_output_observed: wire.model_output_observed,
            tool_activity_observed: wire.tool_activity_observed,
            terminal_event_observed: wire.terminal_event_observed,
        };
        plan.validate().map(|_| plan).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryResult {
    RetryScheduled(RecoveryPlan),
    Terminal(TerminalOutcome),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckpoint {
    pub session_id: String,
    pub pristine: bool,
}

impl SessionCheckpoint {
    fn validate(&self) -> Result<(), AttemptError> {
        bounded_string(self.session_id.clone(), "session_id", MAX_ID_BYTES).map(|_| ())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionCheckpointWire {
    session_id: String,
    pristine: bool,
}

impl<'de> Deserialize<'de> for SessionCheckpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = SessionCheckpointWire::deserialize(deserializer)?;
        let session = Self {
            session_id: wire.session_id,
            pristine: wire.pristine,
        };
        session
            .validate()
            .map(|_| session)
            .map_err(de::Error::custom)
    }
}

fn checkpoint_invalid(message: impl Into<String>) -> AttemptError {
    AttemptError::new("checkpoint_invalid", ErrorKind::CheckpointInvalid, message)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub protocol_version: u16,
    pub identity: HeartbeatIdentity,
    pub attempt: AttemptIdentity,
    pub phase: Phase,
    pub network_wait_count: u8,
    pub session: SessionCheckpoint,
    pub lease: LeaseFence,
    pub idempotency_key: IdempotencyKey,
    pub request_fingerprint: String,
    pub submission_phase: SubmissionPhase,
    pub side_effect_risk: SideEffectRisk,
    pub model_output_observed: bool,
    pub tool_activity_observed: bool,
    pub terminal_event_observed: bool,
    pub revision: u64,
    pub cancellation: CancellationState,
    pub last_failure: Option<Failure>,
    pub recovery: Option<RecoveryPlan>,
    pub terminal_outcome: Option<TerminalOutcome>,
}

impl Checkpoint {
    fn evidence(&self) -> RecoveryEvidence {
        RecoveryEvidence {
            submission_phase: self.submission_phase,
            side_effect_risk: self.side_effect_risk,
            model_output_observed: self.model_output_observed,
            tool_activity_observed: self.tool_activity_observed,
            terminal_event_observed: self.terminal_event_observed,
        }
    }

    fn validate(&self) -> Result<(), AttemptError> {
        if self.protocol_version != ATTEMPT_PROTOCOL_VERSION {
            return Err(checkpoint_invalid(
                "unsupported checkpoint protocol version",
            ));
        }
        self.identity
            .validate()
            .map_err(|error| checkpoint_invalid(error.message()))?;
        self.attempt
            .validate()
            .map_err(|error| checkpoint_invalid(error.message()))?;
        if self.identity != self.attempt.heartbeat_identity() {
            return Err(checkpoint_invalid(
                "checkpoint identity and attempt do not agree",
            ));
        }
        if self.network_wait_count > MAX_NETWORK_WAITS {
            return Err(checkpoint_invalid(
                "checkpoint network wait count exceeds its bound",
            ));
        }
        self.session
            .validate()
            .map_err(|error| checkpoint_invalid(error.message()))?;
        self.lease
            .validate()
            .map_err(|error| checkpoint_invalid(error.message()))?;
        self.idempotency_key
            .validate()
            .map_err(|error| checkpoint_invalid(error.message()))?;
        bounded_string(
            self.request_fingerprint.clone(),
            "request_fingerprint",
            MAX_REQUEST_FINGERPRINT_BYTES,
        )
        .map_err(|error| checkpoint_invalid(error.message()))?;
        let evidence = self.evidence();
        evidence
            .validate()
            .map_err(|error| checkpoint_invalid(error.message()))?;
        if self.session.pristine && evidence != RecoveryEvidence::pre_submission() {
            return Err(checkpoint_invalid(
                "a session with submission evidence cannot remain pristine",
            ));
        }
        if let Some(failure) = &self.last_failure {
            failure
                .validate()
                .map_err(|error| checkpoint_invalid(error.message()))?;
        }
        if let Some(plan) = &self.recovery {
            plan.validate()
                .map_err(|error| checkpoint_invalid(error.message()))?;
            if plan.failed_attempt.heartbeat_identity() != self.identity
                || plan.next_attempt.heartbeat_identity() != self.identity
            {
                return Err(checkpoint_invalid(
                    "recovery plan identity is not bound to the checkpoint",
                ));
            }
            if plan.network_wait_number != self.network_wait_count {
                return Err(checkpoint_invalid(
                    "recovery plan wait count does not match the checkpoint",
                ));
            }
        }
        if let Some(outcome) = &self.terminal_outcome {
            outcome
                .validate()
                .map_err(|error| checkpoint_invalid(error.message()))?;
            let outcome_attempt = match outcome {
                TerminalOutcome::Succeeded { attempt }
                | TerminalOutcome::Cancelled { attempt, .. }
                | TerminalOutcome::Failed { attempt, .. }
                | TerminalOutcome::NetworkRetryExhausted { attempt, .. }
                | TerminalOutcome::NetworkResumeUnsafe { attempt, .. } => attempt,
            };
            if outcome_attempt != &self.attempt {
                return Err(checkpoint_invalid(
                    "terminal outcome attempt is not bound to the checkpoint",
                ));
            }
        }

        let expected_active_attempt = self
            .network_wait_count
            .checked_add(1)
            .ok_or_else(|| checkpoint_invalid("checkpoint attempt progression overflow"))?;
        match self.phase {
            Phase::Pristine => {
                if self.attempt.attempt != 1
                    || self.network_wait_count != 0
                    || !self.session.pristine
                    || self.revision != 0
                    || self.cancellation != CancellationState::NotRequested
                    || self.last_failure.is_some()
                    || self.recovery.is_some()
                    || self.terminal_outcome.is_some()
                    || evidence != RecoveryEvidence::pre_submission()
                {
                    return Err(checkpoint_invalid("pristine phase has inconsistent state"));
                }
            }
            Phase::Executing | Phase::WaitingForNetwork => {
                if self.attempt.attempt != expected_active_attempt
                    || self.cancellation != CancellationState::NotRequested
                    || self.terminal_outcome.is_some()
                    || self.revision == 0
                {
                    return Err(checkpoint_invalid("active phase has inconsistent state"));
                }
                if let Some(plan) = &self.recovery {
                    if plan.next_attempt != self.attempt
                        || self.last_failure.as_ref() != Some(&plan.failure)
                    {
                        return Err(checkpoint_invalid(
                            "active phase recovery plan does not name the active attempt",
                        ));
                    }
                } else if self.network_wait_count != 0
                    || self.attempt.attempt != 1
                    || self.last_failure.is_some()
                {
                    return Err(checkpoint_invalid(
                        "active phase is missing its recovery history",
                    ));
                }
            }
            Phase::WaitingForRetry => {
                let plan = self
                    .recovery
                    .as_ref()
                    .ok_or_else(|| checkpoint_invalid("retry phase has no recovery plan"))?;
                if self.network_wait_count == 0
                    || self.attempt.attempt != self.network_wait_count
                    || plan.failed_attempt != self.attempt
                    || self.last_failure.as_ref() != Some(&plan.failure)
                    || self.cancellation != CancellationState::NotRequested
                    || self.terminal_outcome.is_some()
                    || plan.evidence() != evidence
                    || (plan.decision == RecoveryDecision::FreshIfPristine
                        && !self.session.pristine)
                    || (plan.decision == RecoveryDecision::ResumeSameSession
                        && plan.evidence().submission_phase == SubmissionPhase::PreSubmission
                        && self.session.pristine)
                {
                    return Err(checkpoint_invalid("retry phase has inconsistent state"));
                }
            }
            Phase::Succeeded => {
                if self.cancellation != CancellationState::NotRequested
                    || self.last_failure.is_some()
                    || self.recovery.is_some()
                    || self.revision == 0
                    || self.attempt.attempt != expected_active_attempt
                    || !matches!(
                        self.terminal_outcome,
                        Some(TerminalOutcome::Succeeded { .. })
                    )
                    || evidence.submission_phase == SubmissionPhase::Indeterminate
                {
                    return Err(checkpoint_invalid("succeeded phase has inconsistent state"));
                }
            }
            Phase::Terminal => {
                if self.recovery.is_some()
                    || self.terminal_outcome.is_none()
                    || self.revision == 0
                    || (self.attempt.attempt != expected_active_attempt
                        && self.attempt.attempt != self.network_wait_count)
                {
                    return Err(checkpoint_invalid("terminal phase has inconsistent state"));
                }
                if matches!(
                    self.terminal_outcome,
                    Some(TerminalOutcome::NetworkRetryExhausted { .. })
                ) && (evidence.submission_phase == SubmissionPhase::Indeterminate
                    || evidence.terminal_event_observed)
                {
                    return Err(checkpoint_invalid(
                        "network exhaustion cannot contain unsafe submission evidence",
                    ));
                }
                match (&self.cancellation, self.terminal_outcome.as_ref()) {
                    (
                        CancellationState::Requested(reason),
                        Some(TerminalOutcome::Cancelled {
                            reason: outcome_reason,
                            ..
                        }),
                    ) if reason == outcome_reason => {}
                    (CancellationState::Requested(_), _) => {
                        return Err(checkpoint_invalid(
                            "cancellation state does not match terminal outcome",
                        ));
                    }
                    (CancellationState::NotRequested, Some(TerminalOutcome::Cancelled { .. })) => {
                        return Err(checkpoint_invalid(
                            "cancelled outcome is missing its cancellation state",
                        ));
                    }
                    (CancellationState::NotRequested, Some(TerminalOutcome::Succeeded { .. })) => {
                        return Err(checkpoint_invalid(
                            "successful outcome belongs to the succeeded phase",
                        ));
                    }
                    (CancellationState::NotRequested, Some(outcome)) => {
                        if self.last_failure.as_ref() != outcome.failure() {
                            return Err(checkpoint_invalid(
                                "terminal failure does not match the last failure",
                            ));
                        }
                    }
                    (CancellationState::NotRequested, None) => {
                        return Err(checkpoint_invalid("terminal phase has no outcome"));
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointWire {
    protocol_version: u16,
    identity: HeartbeatIdentity,
    attempt: AttemptIdentity,
    phase: Phase,
    network_wait_count: u8,
    session: SessionCheckpoint,
    lease: LeaseFence,
    idempotency_key: IdempotencyKey,
    request_fingerprint: String,
    submission_phase: SubmissionPhase,
    side_effect_risk: SideEffectRisk,
    model_output_observed: bool,
    tool_activity_observed: bool,
    terminal_event_observed: bool,
    revision: u64,
    cancellation: CancellationState,
    last_failure: Option<Failure>,
    recovery: Option<RecoveryPlan>,
    terminal_outcome: Option<TerminalOutcome>,
}

impl<'de> Deserialize<'de> for Checkpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = CheckpointWire::deserialize(deserializer)?;
        let checkpoint = Self {
            protocol_version: wire.protocol_version,
            identity: wire.identity,
            attempt: wire.attempt,
            phase: wire.phase,
            network_wait_count: wire.network_wait_count,
            session: wire.session,
            lease: wire.lease,
            idempotency_key: wire.idempotency_key,
            request_fingerprint: wire.request_fingerprint,
            submission_phase: wire.submission_phase,
            side_effect_risk: wire.side_effect_risk,
            model_output_observed: wire.model_output_observed,
            tool_activity_observed: wire.tool_activity_observed,
            terminal_event_observed: wire.terminal_event_observed,
            revision: wire.revision,
            cancellation: wire.cancellation,
            last_failure: wire.last_failure,
            recovery: wire.recovery,
            terminal_outcome: wire.terminal_outcome,
        };
        checkpoint
            .validate()
            .map(|_| checkpoint)
            .map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
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

impl<'de> Deserialize<'de> for IdempotencyKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl IdempotencyKey {
    fn validate(&self) -> Result<(), AttemptError> {
        bounded_string(self.0.clone(), "idempotency_key", MAX_ID_BYTES).map(|_| ())
    }
}

impl From<IdempotencyKey> for String {
    fn from(value: IdempotencyKey) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyRecord {
    pub identity: HeartbeatIdentity,
    pub key: IdempotencyKey,
    pub fingerprint: String,
    pub outcome: Option<TerminalOutcome>,
}

impl IdempotencyRecord {
    fn validate(&self) -> Result<(), AttemptError> {
        self.identity.validate()?;
        self.key.validate()?;
        bounded_string(
            self.fingerprint.clone(),
            "request_fingerprint",
            MAX_REQUEST_FINGERPRINT_BYTES,
        )?;
        if let Some(outcome) = &self.outcome {
            outcome.validate()?;
            let outcome_identity = match outcome {
                TerminalOutcome::Succeeded { attempt }
                | TerminalOutcome::Cancelled { attempt, .. }
                | TerminalOutcome::Failed { attempt, .. }
                | TerminalOutcome::NetworkRetryExhausted { attempt, .. }
                | TerminalOutcome::NetworkResumeUnsafe { attempt, .. } => {
                    attempt.heartbeat_identity()
                }
            };
            if outcome_identity != self.identity {
                return Err(AttemptError::new(
                    "idempotency_conflict",
                    ErrorKind::IdempotencyConflict,
                    "terminal outcome identity does not match its idempotency record",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdempotencyRecordWire {
    identity: HeartbeatIdentity,
    key: IdempotencyKey,
    fingerprint: String,
    outcome: Option<TerminalOutcome>,
}

impl<'de> Deserialize<'de> for IdempotencyRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = IdempotencyRecordWire::deserialize(deserializer)?;
        let record = Self {
            identity: wire.identity,
            key: wire.key,
            fingerprint: wire.fingerprint,
            outcome: wire.outcome,
        };
        record.validate().map(|_| record).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyDecision {
    New,
    Replay { run_id: String },
}

fn deserialize_bounded_records<'de, D>(deserializer: D) -> Result<Vec<IdempotencyRecord>, D::Error>
where
    D: Deserializer<'de>,
{
    struct RecordsVisitor;

    impl<'de> de::Visitor<'de> for RecordsVisitor {
        type Value = Vec<IdempotencyRecord>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a bounded sequence of idempotency records")
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: de::SeqAccess<'de>,
        {
            let mut records = Vec::new();
            while let Some(record) = sequence.next_element()? {
                if records.len() >= MAX_IDEMPOTENCY_RECORDS {
                    return Err(de::Error::custom(
                        "idempotency ledger exceeds its record bound",
                    ));
                }
                records.push(record);
            }
            Ok(records)
        }
    }

    deserializer.deserialize_seq(RecordsVisitor)
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyLedger {
    records: Vec<IdempotencyRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdempotencyLedgerWire {
    #[serde(deserialize_with = "deserialize_bounded_records")]
    records: Vec<IdempotencyRecord>,
}

impl<'de> Deserialize<'de> for IdempotencyLedger {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = IdempotencyLedgerWire::deserialize(deserializer)?;
        let ledger = Self {
            records: wire.records,
        };
        ledger.validate().map(|_| ledger).map_err(de::Error::custom)
    }
}

impl IdempotencyLedger {
    fn validate(&self) -> Result<(), AttemptError> {
        if self.records.len() > MAX_IDEMPOTENCY_RECORDS {
            return Err(AttemptError::invalid(
                "idempotency ledger exceeds its record bound",
            ));
        }
        for (index, record) in self.records.iter().enumerate() {
            record.validate()?;
            if self.records[..index]
                .iter()
                .any(|existing| existing.identity == record.identity && existing.key == record.key)
            {
                return Err(AttemptError::new(
                    "idempotency_conflict",
                    ErrorKind::IdempotencyConflict,
                    "idempotency ledger contains a duplicate identity and key",
                ));
            }
        }
        Ok(())
    }

    pub fn reserve_for_identity(
        &mut self,
        identity: impl Borrow<HeartbeatIdentity>,
        key: impl Borrow<IdempotencyKey>,
        fingerprint: impl Into<String>,
    ) -> Result<IdempotencyDecision, AttemptError> {
        let identity = identity.borrow().clone();
        let key = key.borrow().clone();
        identity.validate()?;
        key.validate()?;
        let fingerprint = bounded_string(
            fingerprint,
            "request_fingerprint",
            MAX_REQUEST_FINGERPRINT_BYTES,
        )?;
        if let Some(existing) = self
            .records
            .iter()
            .find(|record| record.identity == identity && record.key == key)
        {
            if existing.fingerprint == fingerprint {
                return Ok(IdempotencyDecision::Replay {
                    run_id: existing.identity.run_id.clone(),
                });
            }
            return Err(AttemptError::new(
                "idempotency_conflict",
                ErrorKind::IdempotencyConflict,
                "idempotency key was reused with a different fingerprint",
            ));
        }
        if self.records.len() >= MAX_IDEMPOTENCY_RECORDS {
            return Err(AttemptError::invalid(
                "idempotency ledger exceeds its record bound",
            ));
        }
        self.records.push(IdempotencyRecord {
            identity,
            key,
            fingerprint,
            outcome: None,
        });
        Ok(IdempotencyDecision::New)
    }

    pub fn record_outcome_for_identity(
        &mut self,
        identity: &HeartbeatIdentity,
        key: &IdempotencyKey,
        fingerprint: impl AsRef<str>,
        outcome: TerminalOutcome,
    ) -> Result<(), AttemptError> {
        identity.validate()?;
        key.validate()?;
        let fingerprint = bounded_string(
            fingerprint.as_ref().to_owned(),
            "request_fingerprint",
            MAX_REQUEST_FINGERPRINT_BYTES,
        )?;
        outcome.validate()?;
        let outcome_identity = match &outcome {
            TerminalOutcome::Succeeded { attempt }
            | TerminalOutcome::Cancelled { attempt, .. }
            | TerminalOutcome::Failed { attempt, .. }
            | TerminalOutcome::NetworkRetryExhausted { attempt, .. }
            | TerminalOutcome::NetworkResumeUnsafe { attempt, .. } => attempt.heartbeat_identity(),
        };
        if outcome_identity != *identity {
            return Err(AttemptError::new(
                "idempotency_conflict",
                ErrorKind::IdempotencyConflict,
                "terminal outcome identity does not match the trusted identity",
            ));
        }
        let record = self
            .records
            .iter_mut()
            .find(|record| record.identity == *identity && record.key == *key);
        let Some(record) = record else {
            if self.records.iter().any(|record| record.key == *key) {
                return Err(AttemptError::new(
                    "idempotency_conflict",
                    ErrorKind::IdempotencyConflict,
                    "idempotency key belongs to a different trusted identity",
                ));
            }
            return Err(AttemptError::new(
                "idempotency_missing",
                ErrorKind::InvalidInput,
                "idempotency key has not been reserved",
            ));
        };
        if record.fingerprint != fingerprint {
            return Err(AttemptError::new(
                "idempotency_conflict",
                ErrorKind::IdempotencyConflict,
                "terminal outcome fingerprint does not match its reservation",
            ));
        }
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

    pub fn outcome_for_identity(
        &self,
        identity: &HeartbeatIdentity,
        key: &IdempotencyKey,
        fingerprint: impl AsRef<str>,
    ) -> Option<&TerminalOutcome> {
        self.records
            .iter()
            .find(|record| {
                record.identity == *identity
                    && record.key == *key
                    && record.fingerprint == fingerprint.as_ref()
            })
            .and_then(|record| record.outcome.as_ref())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptMachine {
    identity: HeartbeatIdentity,
    attempt: u8,
    phase: Phase,
    network_wait_count: u8,
    session: SessionCheckpoint,
    lease: LeaseFence,
    idempotency_key: IdempotencyKey,
    request_fingerprint: String,
    submission_phase: SubmissionPhase,
    side_effect_risk: SideEffectRisk,
    model_output_observed: bool,
    tool_activity_observed: bool,
    terminal_event_observed: bool,
    revision: u64,
    cancellation: CancellationState,
    last_failure: Option<Failure>,
    recovery: Option<RecoveryPlan>,
    terminal_outcome: Option<TerminalOutcome>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttemptMachineWire {
    identity: HeartbeatIdentity,
    attempt: u8,
    phase: Phase,
    network_wait_count: u8,
    session: SessionCheckpoint,
    lease: LeaseFence,
    idempotency_key: IdempotencyKey,
    request_fingerprint: String,
    submission_phase: SubmissionPhase,
    side_effect_risk: SideEffectRisk,
    model_output_observed: bool,
    tool_activity_observed: bool,
    terminal_event_observed: bool,
    revision: u64,
    cancellation: CancellationState,
    last_failure: Option<Failure>,
    recovery: Option<RecoveryPlan>,
    terminal_outcome: Option<TerminalOutcome>,
}

impl<'de> Deserialize<'de> for AttemptMachine {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = AttemptMachineWire::deserialize(deserializer)?;
        let attempt = wire
            .identity
            .attempt(wire.attempt)
            .map_err(de::Error::custom)?;
        let checkpoint = Checkpoint {
            protocol_version: ATTEMPT_PROTOCOL_VERSION,
            identity: wire.identity,
            attempt,
            phase: wire.phase,
            network_wait_count: wire.network_wait_count,
            session: wire.session,
            lease: wire.lease,
            idempotency_key: wire.idempotency_key,
            request_fingerprint: wire.request_fingerprint,
            submission_phase: wire.submission_phase,
            side_effect_risk: wire.side_effect_risk,
            model_output_observed: wire.model_output_observed,
            tool_activity_observed: wire.tool_activity_observed,
            terminal_event_observed: wire.terminal_event_observed,
            revision: wire.revision,
            cancellation: wire.cancellation,
            last_failure: wire.last_failure,
            recovery: wire.recovery,
            terminal_outcome: wire.terminal_outcome,
        };
        Self::from_checkpoint(checkpoint).map_err(de::Error::custom)
    }
}

impl AttemptMachine {
    pub fn new(
        identity: HeartbeatIdentity,
        session_id: impl Into<String>,
        lease: LeaseFence,
        idempotency_key: impl Into<String>,
        request_fingerprint: impl Into<String>,
    ) -> Result<Self, AttemptError> {
        identity.validate()?;
        lease.validate()?;
        Ok(Self {
            identity,
            attempt: 1,
            phase: Phase::Pristine,
            network_wait_count: 0,
            session: SessionCheckpoint {
                session_id: bounded_string(session_id, "session_id", MAX_ID_BYTES)?,
                pristine: true,
            },
            lease,
            idempotency_key: IdempotencyKey::new(idempotency_key)?,
            request_fingerprint: bounded_string(
                request_fingerprint,
                "request_fingerprint",
                MAX_REQUEST_FINGERPRINT_BYTES,
            )?,
            submission_phase: SubmissionPhase::PreSubmission,
            side_effect_risk: SideEffectRisk::None,
            model_output_observed: false,
            tool_activity_observed: false,
            terminal_event_observed: false,
            revision: 0,
            cancellation: CancellationState::NotRequested,
            last_failure: None,
            recovery: None,
            terminal_outcome: None,
        })
    }

    pub fn from_checkpoint(checkpoint: Checkpoint) -> Result<Self, AttemptError> {
        checkpoint
            .validate()
            .map_err(|error| checkpoint_invalid(error.message()))?;
        Ok(Self {
            identity: checkpoint.identity,
            attempt: checkpoint.attempt.attempt,
            phase: checkpoint.phase,
            network_wait_count: checkpoint.network_wait_count,
            session: checkpoint.session,
            lease: checkpoint.lease,
            idempotency_key: checkpoint.idempotency_key,
            request_fingerprint: checkpoint.request_fingerprint,
            submission_phase: checkpoint.submission_phase,
            side_effect_risk: checkpoint.side_effect_risk,
            model_output_observed: checkpoint.model_output_observed,
            tool_activity_observed: checkpoint.tool_activity_observed,
            terminal_event_observed: checkpoint.terminal_event_observed,
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
            network_wait_count: self.network_wait_count,
            session: self.session.clone(),
            lease: self.lease.clone(),
            idempotency_key: self.idempotency_key.clone(),
            request_fingerprint: self.request_fingerprint.clone(),
            submission_phase: self.submission_phase,
            side_effect_risk: self.side_effect_risk,
            model_output_observed: self.model_output_observed,
            tool_activity_observed: self.tool_activity_observed,
            terminal_event_observed: self.terminal_event_observed,
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

    pub fn lease(&self) -> &LeaseFence {
        &self.lease
    }

    pub fn attempt_identity(&self) -> AttemptIdentity {
        debug_assert!((1..=MAX_ATTEMPTS).contains(&self.attempt));
        AttemptIdentity {
            organization_id: self.identity.organization_id.clone(),
            run_id: self.identity.run_id.clone(),
            agent_id: self.identity.agent_id.clone(),
            attempt: self.attempt,
        }
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

    pub fn network_wait_count(&self) -> u8 {
        self.network_wait_count
    }

    pub fn recovery_evidence(&self) -> RecoveryEvidence {
        RecoveryEvidence {
            submission_phase: self.submission_phase,
            side_effect_risk: self.side_effect_risk,
            model_output_observed: self.model_output_observed,
            tool_activity_observed: self.tool_activity_observed,
            terminal_event_observed: self.terminal_event_observed,
        }
    }

    pub fn submission_phase(&self) -> SubmissionPhase {
        self.submission_phase
    }

    pub fn side_effect_risk(&self) -> SideEffectRisk {
        self.side_effect_risk
    }

    pub fn model_output_observed(&self) -> bool {
        self.model_output_observed
    }

    pub fn tool_activity_observed(&self) -> bool {
        self.tool_activity_observed
    }

    pub fn terminal_event_observed(&self) -> bool {
        self.terminal_event_observed
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

    /// Replace an expired or superseded lease only when the exact current fence is presented.
    /// The replacement must be a newer, currently valid fence; no lease authority is performed
    /// by this crate.
    pub fn rebind_lease(
        &mut self,
        current_fence: &LeaseFence,
        new_lease: LeaseFence,
        now_millis: u64,
    ) -> Result<Checkpoint, AttemptError> {
        if &self.lease != current_fence {
            return Err(AttemptError::new(
                "stale_lease_fence",
                ErrorKind::StaleLeaseFence,
                "presented lease fence does not own this attempt",
            ));
        }
        new_lease.validate()?;
        if new_lease.epoch <= self.lease.epoch {
            return Err(AttemptError::new(
                "stale_lease_fence",
                ErrorKind::StaleLeaseFence,
                "replacement lease epoch must advance the current fence",
            ));
        }
        if !new_lease.valid_at(now_millis) {
            return Err(AttemptError::new(
                "lease_expired",
                ErrorKind::LeaseExpired,
                "replacement lease is not valid at the supplied time",
            ));
        }
        self.bump_revision()?;
        self.lease = new_lease;
        Ok(self.checkpoint())
    }

    pub fn renew_lease(
        &mut self,
        current_fence: &LeaseFence,
        new_lease: LeaseFence,
        now_millis: u64,
    ) -> Result<Checkpoint, AttemptError> {
        self.rebind_lease(current_fence, new_lease, now_millis)
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

    fn install_evidence(&mut self, evidence: RecoveryEvidence) -> Result<(), AttemptError> {
        let current = self.recovery_evidence();
        let merged = current.merge(evidence)?;
        if merged == current {
            return Ok(());
        }
        self.submission_phase = merged.submission_phase;
        self.side_effect_risk = merged.side_effect_risk;
        self.model_output_observed = merged.model_output_observed;
        self.tool_activity_observed = merged.tool_activity_observed;
        self.terminal_event_observed = merged.terminal_event_observed;
        if merged != RecoveryEvidence::pre_submission() {
            self.session.pristine = false;
        }
        self.bump_revision()
    }

    pub fn record_evidence(
        &mut self,
        evidence: RecoveryEvidence,
        fence: &LeaseFence,
        now_millis: u64,
    ) -> Result<Checkpoint, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        self.ensure_not_cancelled()?;
        match self.phase {
            Phase::Pristine => {
                if evidence != RecoveryEvidence::pre_submission() {
                    return Err(AttemptError::new(
                        "invalid_transition",
                        ErrorKind::InvalidTransition,
                        "submission evidence requires an executing attempt",
                    ));
                }
                Ok(self.checkpoint())
            }
            Phase::Executing | Phase::WaitingForNetwork => {
                self.install_evidence(evidence)?;
                Ok(self.checkpoint())
            }
            Phase::WaitingForRetry => {
                if self.recovery_evidence() != evidence {
                    return Err(AttemptError::new(
                        "idempotency_conflict",
                        ErrorKind::IdempotencyConflict,
                        "retry evidence cannot change after it is scheduled",
                    ));
                }
                Ok(self.checkpoint())
            }
            Phase::Succeeded | Phase::Terminal => Err(AttemptError::new(
                "already_terminal",
                ErrorKind::AlreadyTerminal,
                "attempt evidence cannot change after completion",
            )),
        }
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
        outcome.validate()?;
        if outcome.failure() != failure.as_ref() {
            return Err(AttemptError::invalid(
                "terminal outcome and last failure do not match",
            ));
        }
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
        if self.submission_phase == SubmissionPhase::Indeterminate || self.terminal_event_observed {
            return Err(AttemptError::new(
                "network_resume_unsafe",
                ErrorKind::NetworkResumeUnsafe,
                "an indeterminate or terminal event cannot be recorded as success",
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
        self.record_failure_internal(failure, None, fence, now_millis, jitter_seed)
    }

    pub fn record_failure_with_evidence(
        &mut self,
        failure: Failure,
        evidence: RecoveryEvidence,
        fence: &LeaseFence,
        now_millis: u64,
        jitter_seed: Option<u64>,
    ) -> Result<RecoveryResult, AttemptError> {
        self.record_failure_internal(failure, Some(evidence), fence, now_millis, jitter_seed)
    }

    fn record_failure_internal(
        &mut self,
        failure: Failure,
        evidence: Option<RecoveryEvidence>,
        fence: &LeaseFence,
        now_millis: u64,
        jitter_seed: Option<u64>,
    ) -> Result<RecoveryResult, AttemptError> {
        self.lease.assert_presented(fence, now_millis)?;
        self.ensure_not_cancelled()?;
        failure.validate()?;

        let current_evidence = self.recovery_evidence();
        let effective_evidence = match evidence {
            Some(evidence) if matches!(self.phase, Phase::WaitingForRetry | Phase::Terminal) => {
                if evidence != current_evidence {
                    return Err(AttemptError::new(
                        "idempotency_conflict",
                        ErrorKind::IdempotencyConflict,
                        "recovery evidence cannot change after the result is recorded",
                    ));
                }
                current_evidence
            }
            Some(evidence) => current_evidence.merge(evidence)?,
            None => current_evidence,
        };

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

        let current_attempt = self.attempt_identity();
        if effective_evidence != current_evidence {
            self.install_evidence(effective_evidence)?;
        }
        if failure.classification() == FailureClassification::Ambiguous {
            let outcome = TerminalOutcome::NetworkResumeUnsafe {
                attempt: current_attempt,
                failure: failure.clone(),
            };
            return self.install_terminal(outcome, Some(failure));
        }
        if !failure.retryable() {
            let outcome = TerminalOutcome::Failed {
                attempt: current_attempt,
                failure: failure.clone(),
            };
            return self.install_terminal(outcome, Some(failure));
        }

        let retry_number = self
            .network_wait_count
            .checked_add(1)
            .ok_or_else(|| AttemptError::invalid("network wait count overflow"))?;
        if retry_number > MAX_NETWORK_WAITS {
            let outcome = TerminalOutcome::NetworkRetryExhausted {
                attempt: current_attempt,
                failure: failure.clone(),
            };
            return self.install_terminal(outcome, Some(failure));
        }
        let decision = effective_evidence.decision(self.session.pristine, true);
        if decision == RecoveryDecision::FailClosed {
            let outcome = TerminalOutcome::NetworkResumeUnsafe {
                attempt: current_attempt,
                failure: failure.clone(),
            };
            return self.install_terminal(outcome, Some(failure));
        }
        let backoff = BackoffDelay::for_retry(retry_number, jitter_seed)?;
        let next_attempt_number = self
            .attempt
            .checked_add(1)
            .ok_or_else(|| AttemptError::invalid("attempt progression overflow"))?;
        let next_attempt = self.identity.attempt(next_attempt_number)?;
        let next_attempt_at_millis = now_millis
            .checked_add(backoff.delay_millis)
            .ok_or_else(|| AttemptError::invalid("retry timestamp overflow"))?;
        let plan = RecoveryPlan {
            failed_attempt: current_attempt,
            next_attempt,
            classification: failure.classification(),
            decision,
            backoff,
            network_wait_number: retry_number,
            next_attempt_at_millis,
            failure: failure.clone(),
            submission_phase: effective_evidence.submission_phase,
            side_effect_risk: effective_evidence.side_effect_risk,
            model_output_observed: effective_evidence.model_output_observed,
            tool_activity_observed: effective_evidence.tool_activity_observed,
            terminal_event_observed: effective_evidence.terminal_event_observed,
        };
        self.bump_revision()?;
        self.network_wait_count = retry_number;
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
        if decision == RecoveryDecision::FailClosed {
            return Err(AttemptError::new(
                "network_resume_unsafe",
                ErrorKind::NetworkResumeUnsafe,
                "an unsafe recovery plan must be failed closed",
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
            let session_id = bounded_string(session_id, "session_id", MAX_ID_BYTES)?;
            if session_id == self.session.session_id {
                return Err(AttemptError::new(
                    "recovery_choice_mismatch",
                    ErrorKind::RecoveryChoiceMismatch,
                    "fresh_if_pristine requires a different session id",
                ));
            }
            self.session.session_id = session_id;
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
