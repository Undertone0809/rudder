//! Pure, bounded protocol state machines for the execution, chat, and automation runtimes.
//!
//! This crate deliberately owns no process, network, or database side effects. Adapters
//! translate the state transitions here to the current Node/database authority and must
//! carry the returned identity, lease, and fence values across that boundary.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

pub const RUNTIME_CORE_PROTOCOL_VERSION: u16 = 1;
pub const MAX_IDEMPOTENCY_KEY_BYTES: usize = 255;
pub const MAX_IDENTITY_PART_BYTES: usize = 255;
pub const MAX_FAILURE_CODE_BYTES: usize = 128;
pub const MAX_FAILURE_SUMMARY_BYTES: usize = 4 * 1024;
pub const MAX_AUTOMATION_CATCH_UP_RUNS: usize = 25;

const DEFAULT_STDOUT_BYTES: usize = 64 * 1024;
const DEFAULT_STDERR_BYTES: usize = 64 * 1024;
const DEFAULT_RESULT_BYTES: usize = 64 * 1024;
const DEFAULT_ENVELOPE_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCategory {
    AdmissionRejected,
    InvalidInput,
    Conflict,
    StaleFence,
    LeaseExpired,
    Cancelled,
    TimedOut,
    Provider,
    Network,
    OutputLimit,
    IdempotencyConflict,
    RetryExhausted,
    Internal,
}

impl FailureCategory {
    pub fn retryable_by_default(self) -> bool {
        matches!(
            self,
            Self::LeaseExpired | Self::TimedOut | Self::Provider | Self::Network
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeError {
    code: &'static str,
    category: FailureCategory,
    message: String,
}

impl RuntimeError {
    fn new(code: &'static str, category: FailureCategory, message: impl Into<String>) -> Self {
        Self {
            code,
            category,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_input", FailureCategory::InvalidInput, message)
    }

    fn transition(message: impl Into<String>) -> Self {
        Self::new("invalid_transition", FailureCategory::Conflict, message)
    }

    fn fence(message: impl Into<String>) -> Self {
        Self::new("stale_fence", FailureCategory::StaleFence, message)
    }

    fn lease_expired() -> Self {
        Self::new(
            "lease_expired",
            FailureCategory::LeaseExpired,
            "runtime lease expired",
        )
    }

    fn terminal() -> Self {
        Self::new(
            "already_terminal",
            FailureCategory::Conflict,
            "runtime is already terminal",
        )
    }

    fn output_limit(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, FailureCategory::OutputLimit, message)
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn category(&self) -> FailureCategory {
        self.category
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RuntimeError {}

fn bounded_string(
    value: impl Into<String>,
    field: &'static str,
    max_bytes: usize,
) -> Result<String, RuntimeError> {
    let value = value.into();
    if value.trim().is_empty() {
        return Err(RuntimeError::invalid(format!("{field} must not be empty")));
    }
    if value.len() > max_bytes {
        return Err(RuntimeError::invalid(format!(
            "{field} exceeds {max_bytes} bytes"
        )));
    }
    Ok(value)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorType {
    User,
    Agent,
    System,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorIdentity {
    pub actor_type: ActorType,
    pub actor_id: String,
}

impl ActorIdentity {
    pub fn new(actor_type: ActorType, actor_id: impl Into<String>) -> Result<Self, RuntimeError> {
        Ok(Self {
            actor_type,
            actor_id: bounded_string(actor_id, "actor_id", MAX_IDENTITY_PART_BYTES)?,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub org_id: String,
    pub run_id: String,
    pub actor: ActorIdentity,
}

impl RuntimeIdentity {
    pub fn new(
        org_id: impl Into<String>,
        run_id: impl Into<String>,
        actor: ActorIdentity,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            org_id: bounded_string(org_id, "org_id", MAX_IDENTITY_PART_BYTES)?,
            run_id: bounded_string(run_id, "run_id", MAX_IDENTITY_PART_BYTES)?,
            actor,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FenceToken {
    pub epoch: u64,
    pub owner_token: String,
}

impl FenceToken {
    pub fn new(epoch: u64, owner_token: impl Into<String>) -> Result<Self, RuntimeError> {
        if epoch == 0 {
            return Err(RuntimeError::invalid(
                "fence epoch must be greater than zero",
            ));
        }
        Ok(Self {
            epoch,
            owner_token: bounded_string(owner_token, "owner_token", MAX_IDENTITY_PART_BYTES)?,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub owner: String,
    pub fence: FenceToken,
    pub issued_at_millis: u64,
    pub expires_at_millis: u64,
}

impl Lease {
    pub fn new(
        owner: impl Into<String>,
        fence: FenceToken,
        issued_at_millis: u64,
        ttl_millis: u64,
    ) -> Result<Self, RuntimeError> {
        let owner = bounded_string(owner, "lease_owner", MAX_IDENTITY_PART_BYTES)?;
        if ttl_millis == 0 {
            return Err(RuntimeError::invalid("lease ttl must be greater than zero"));
        }
        let expires_at_millis = issued_at_millis
            .checked_add(ttl_millis)
            .ok_or_else(|| RuntimeError::invalid("lease expiry overflow"))?;
        Ok(Self {
            owner,
            fence,
            issued_at_millis,
            expires_at_millis,
        })
    }

    pub fn valid_at(&self, now_millis: u64) -> bool {
        now_millis >= self.issued_at_millis && now_millis < self.expires_at_millis
    }

    pub fn matches(&self, fence: &FenceToken, now_millis: u64) -> bool {
        self.fence == *fence && self.valid_at(now_millis)
    }

    pub fn assert_matches(&self, fence: &FenceToken, now_millis: u64) -> Result<(), RuntimeError> {
        if self.fence != *fence {
            return Err(RuntimeError::fence("fence token does not own the lease"));
        }
        if !self.valid_at(now_millis) {
            return Err(RuntimeError::lease_expired());
        }
        Ok(())
    }

    pub fn renew(&self, now_millis: u64, ttl_millis: u64) -> Result<Self, RuntimeError> {
        if !self.valid_at(now_millis) {
            return Err(RuntimeError::lease_expired());
        }
        Self::new(
            self.owner.clone(),
            self.fence.clone(),
            now_millis,
            ttl_millis,
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunScene {
    Issue,
    Chat,
    Automation,
    Review,
    Heartbeat,
    Delegation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunTargetType {
    Issue,
    ChatConversation,
    ChatMessage,
    AutomationRun,
    WakeupRequest,
    Manual,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunContext {
    pub scene: Option<RunScene>,
    pub trigger_kind: Option<String>,
    pub target_type: Option<RunTargetType>,
    pub target_id: Option<String>,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub automation_run_id: Option<String>,
    pub automation_id: Option<String>,
}

impl RunContext {
    pub fn manual() -> Self {
        Self {
            scene: Some(RunScene::Heartbeat),
            trigger_kind: Some("manual".to_owned()),
            target_type: Some(RunTargetType::Manual),
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionState {
    Requested,
    Queued,
    Admitted,
    Rejected,
    Coalesced,
    Skipped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAdmission {
    state: AdmissionState,
    pub idempotency_key: Option<IdempotencyKey>,
    pub coalesced_into_run_id: Option<String>,
    pub failure: Option<Failure>,
}

impl RunAdmission {
    fn requested(idempotency_key: Option<IdempotencyKey>) -> Self {
        Self {
            state: AdmissionState::Requested,
            idempotency_key,
            coalesced_into_run_id: None,
            failure: None,
        }
    }

    pub fn state(&self) -> AdmissionState {
        self.state
    }

    fn set_queued(&mut self) -> Result<(), RuntimeError> {
        match self.state {
            AdmissionState::Requested | AdmissionState::Queued => {
                self.state = AdmissionState::Queued;
                Ok(())
            }
            _ => Err(RuntimeError::transition(
                "run admission is no longer queueable",
            )),
        }
    }

    fn set_admitted(&mut self) -> Result<(), RuntimeError> {
        match self.state {
            AdmissionState::Requested | AdmissionState::Queued => {
                self.state = AdmissionState::Admitted;
                Ok(())
            }
            _ => Err(RuntimeError::transition(
                "run admission is no longer admissible",
            )),
        }
    }

    fn set_rejected(&mut self, failure: Failure) -> Result<(), RuntimeError> {
        match self.state {
            AdmissionState::Requested | AdmissionState::Queued => {
                self.state = AdmissionState::Rejected;
                self.failure = Some(failure);
                Ok(())
            }
            _ => Err(RuntimeError::transition("run admission is already decided")),
        }
    }

    fn set_coalesced(&mut self, run_id: String) -> Result<(), RuntimeError> {
        match self.state {
            AdmissionState::Requested | AdmissionState::Queued => {
                self.state = AdmissionState::Coalesced;
                self.coalesced_into_run_id = Some(run_id);
                Ok(())
            }
            _ => Err(RuntimeError::transition("run admission is already decided")),
        }
    }

    fn set_skipped(&mut self) -> Result<(), RuntimeError> {
        match self.state {
            AdmissionState::Requested | AdmissionState::Queued => {
                self.state = AdmissionState::Skipped;
                Ok(())
            }
            _ => Err(RuntimeError::transition("run admission is already decided")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::TimedOut
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    Executing,
    WaitingForNetwork,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationReason {
    OperatorStop,
    ClientRequest,
    BudgetPause,
    Shutdown,
    Timeout,
    LeaseLost,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationState {
    NotRequested,
    Requested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputLimits {
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    max_result_bytes: usize,
    max_envelope_bytes: usize,
}

impl Default for OutputLimits {
    fn default() -> Self {
        Self {
            max_stdout_bytes: DEFAULT_STDOUT_BYTES,
            max_stderr_bytes: DEFAULT_STDERR_BYTES,
            max_result_bytes: DEFAULT_RESULT_BYTES,
            max_envelope_bytes: DEFAULT_ENVELOPE_BYTES,
        }
    }
}

impl OutputLimits {
    pub fn new(
        max_stdout_bytes: usize,
        max_stderr_bytes: usize,
        max_result_bytes: usize,
        max_envelope_bytes: usize,
    ) -> Result<Self, RuntimeError> {
        if max_stdout_bytes == 0
            || max_stderr_bytes == 0
            || max_result_bytes == 0
            || max_envelope_bytes == 0
        {
            return Err(RuntimeError::invalid(
                "output limits must be greater than zero",
            ));
        }
        Ok(Self {
            max_stdout_bytes,
            max_stderr_bytes,
            max_result_bytes,
            max_envelope_bytes,
        })
    }

    pub fn max_stdout_bytes(&self) -> usize {
        self.max_stdout_bytes
    }

    pub fn max_stderr_bytes(&self) -> usize {
        self.max_stderr_bytes
    }

    pub fn max_result_bytes(&self) -> usize {
        self.max_result_bytes
    }

    pub fn max_envelope_bytes(&self) -> usize {
        self.max_envelope_bytes
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedOutput {
    text: String,
    original_bytes: usize,
    retained_bytes: usize,
    truncated: bool,
}

impl BoundedOutput {
    pub fn new(value: impl AsRef<str>, max_bytes: usize) -> Result<Self, RuntimeError> {
        if max_bytes == 0 {
            return Err(RuntimeError::invalid(
                "output limit must be greater than zero",
            ));
        }
        let value = value.as_ref();
        let original_bytes = value.len();
        let mut retained_bytes = original_bytes.min(max_bytes);
        while retained_bytes > 0 && !value.is_char_boundary(retained_bytes) {
            retained_bytes -= 1;
        }
        let text = value[..retained_bytes].to_owned();
        Ok(Self {
            text,
            original_bytes,
            retained_bytes,
            truncated: retained_bytes < original_bytes,
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn original_bytes(&self) -> usize {
        self.original_bytes
    }

    pub fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn append(&mut self, value: impl AsRef<str>, max_bytes: usize) -> Result<(), RuntimeError> {
        let combined = format!("{}{}", self.text, value.as_ref());
        *self = Self::new(combined, max_bytes)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub category: FailureCategory,
    pub code: String,
    pub summary: String,
    pub retryable: bool,
    pub attempt: Option<u32>,
}

impl Failure {
    pub fn new(
        category: FailureCategory,
        code: impl Into<String>,
        summary: impl Into<String>,
        retryable: bool,
    ) -> Self {
        let code = code.into();
        let summary = summary.into();
        Self {
            category,
            code: if code.len() <= MAX_FAILURE_CODE_BYTES {
                code
            } else {
                code[..MAX_FAILURE_CODE_BYTES].to_owned()
            },
            summary: if summary.len() <= MAX_FAILURE_SUMMARY_BYTES {
                summary
            } else {
                summary[..MAX_FAILURE_SUMMARY_BYTES].to_owned()
            },
            retryable,
            attempt: None,
        }
    }

    pub fn provider(code: impl Into<String>, summary: impl Into<String>, retryable: bool) -> Self {
        Self::new(FailureCategory::Provider, code, summary, retryable)
    }

    fn cancelled(reason: CancellationReason) -> Self {
        Self::new(
            FailureCategory::Cancelled,
            "cancelled",
            format!("run cancelled: {reason:?}"),
            false,
        )
    }

    fn timed_out() -> Self {
        Self::new(
            FailureCategory::TimedOut,
            "timed_out",
            "run exceeded its execution deadline",
            true,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEnvelope {
    pub status: RunStatus,
    stdout: BoundedOutput,
    stderr: BoundedOutput,
    pub result: Option<Value>,
    pub usage_json: Option<Value>,
    pub error: Option<Failure>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

impl ResultEnvelope {
    pub fn success(
        stdout: impl AsRef<str>,
        stderr: impl AsRef<str>,
        result: Option<Value>,
        limits: OutputLimits,
    ) -> Result<Self, RuntimeError> {
        Self::build(
            RunStatus::Succeeded,
            stdout,
            stderr,
            result,
            None,
            None,
            limits,
        )
    }

    pub fn failure(
        failure: Failure,
        stdout: impl AsRef<str>,
        stderr: impl AsRef<str>,
        limits: OutputLimits,
    ) -> Result<Self, RuntimeError> {
        Self::build(
            RunStatus::Failed,
            stdout,
            stderr,
            None,
            None,
            Some(failure),
            limits,
        )
    }

    fn build(
        status: RunStatus,
        stdout: impl AsRef<str>,
        stderr: impl AsRef<str>,
        result: Option<Value>,
        usage_json: Option<Value>,
        error: Option<Failure>,
        limits: OutputLimits,
    ) -> Result<Self, RuntimeError> {
        if let Some(value) = result.as_ref() {
            let encoded = serde_json::to_vec(value).map_err(|_| {
                RuntimeError::output_limit("result_limit_exceeded", "result is not serializable")
            })?;
            if encoded.len() > limits.max_result_bytes {
                return Err(RuntimeError::output_limit(
                    "result_limit_exceeded",
                    "result exceeds the configured byte limit",
                ));
            }
        }
        let envelope = Self {
            status,
            stdout: BoundedOutput::new(stdout, limits.max_stdout_bytes)?,
            stderr: BoundedOutput::new(stderr, limits.max_stderr_bytes)?,
            result,
            usage_json,
            error,
            exit_code: None,
            signal: None,
        };
        if envelope.encoded_len() > limits.max_envelope_bytes {
            return Err(RuntimeError::output_limit(
                "result_envelope_limit_exceeded",
                "result envelope exceeds the configured byte limit",
            ));
        }
        Ok(envelope)
    }

    pub fn stdout(&self) -> &BoundedOutput {
        &self.stdout
    }

    pub fn stderr(&self) -> &BoundedOutput {
        &self.stderr
    }

    pub fn encoded_len(&self) -> usize {
        serde_json::to_vec(self)
            .map(|encoded| encoded.len())
            .unwrap_or(usize::MAX)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(value: impl Into<String>) -> Result<Self, RuntimeError> {
        Ok(Self(bounded_string(
            value,
            "idempotency_key",
            MAX_IDEMPOTENCY_KEY_BYTES,
        )?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdempotencyRecord {
    pub org_id: String,
    pub key: IdempotencyKey,
    pub fingerprint: String,
    pub run_id: String,
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
        org_id: impl Into<String>,
        key: IdempotencyKey,
        fingerprint: impl Into<String>,
        run_id: impl Into<String>,
    ) -> Result<IdempotencyDecision, RuntimeError> {
        let org_id = bounded_string(org_id, "org_id", MAX_IDENTITY_PART_BYTES)?;
        let fingerprint = bounded_string(fingerprint, "idempotency_fingerprint", 4 * 1024)?;
        let run_id = bounded_string(run_id, "run_id", MAX_IDENTITY_PART_BYTES)?;
        let index = (org_id.clone(), key.clone());
        if let Some(existing) = self.records.get(&index) {
            if existing.fingerprint == fingerprint {
                return Ok(IdempotencyDecision::Replay {
                    run_id: existing.run_id.clone(),
                });
            }
            return Err(RuntimeError::new(
                "idempotency_conflict",
                FailureCategory::IdempotencyConflict,
                "idempotency key was already used with a different request",
            ));
        }
        self.records.insert(
            index,
            IdempotencyRecord {
                org_id,
                key,
                fingerprint,
                run_id,
            },
        );
        Ok(IdempotencyDecision::New)
    }

    pub fn get(&self, org_id: &str, key: &IdempotencyKey) -> Option<&IdempotencyRecord> {
        self.records.get(&(org_id.to_owned(), key.clone()))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_millis: u64,
    pub max_delay_millis: u64,
    pub retryable_categories: Vec<FailureCategory>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay_millis: 1_000,
            max_delay_millis: 60_000,
            retryable_categories: vec![
                FailureCategory::LeaseExpired,
                FailureCategory::TimedOut,
                FailureCategory::Provider,
                FailureCategory::Network,
            ],
        }
    }
}

impl RetryPolicy {
    pub fn new(
        max_attempts: u32,
        base_delay_millis: u64,
        max_delay_millis: u64,
        retryable_categories: Vec<FailureCategory>,
    ) -> Result<Self, RuntimeError> {
        if max_attempts == 0 || max_delay_millis < base_delay_millis {
            return Err(RuntimeError::invalid("invalid retry policy bounds"));
        }
        Ok(Self {
            max_attempts,
            base_delay_millis,
            max_delay_millis,
            retryable_categories,
        })
    }

    fn allows(&self, failure: &Failure) -> bool {
        failure.retryable && self.retryable_categories.contains(&failure.category)
    }

    fn delay_for_attempt(&self, current_attempt: u32) -> u64 {
        let shifts = current_attempt.saturating_sub(1).min(63);
        let multiplier = 1_u64.checked_shl(shifts).unwrap_or(u64::MAX);
        self.base_delay_millis
            .saturating_mul(multiplier)
            .min(self.max_delay_millis)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySchedule {
    pub attempt: u32,
    pub delay_millis: u64,
    pub next_attempt_at_millis: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub identity: RuntimeIdentity,
    pub context: RunContext,
    pub retry_policy: RetryPolicy,
    pub output_limits: OutputLimits,
    pub idempotency_key: Option<IdempotencyKey>,
    pub timeout_millis: Option<u64>,
}

impl RunRequest {
    pub fn new(
        identity: RuntimeIdentity,
        context: RunContext,
        retry_policy: RetryPolicy,
        output_limits: OutputLimits,
        idempotency_key: Option<IdempotencyKey>,
        timeout_millis: Option<u64>,
    ) -> Result<Self, RuntimeError> {
        if timeout_millis == Some(0) {
            return Err(RuntimeError::invalid("timeout must be greater than zero"));
        }
        Ok(Self {
            identity,
            context,
            retry_policy,
            output_limits,
            idempotency_key,
            timeout_millis,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMachine {
    pub request: RunRequest,
    status: RunStatus,
    execution_phase: Option<ExecutionPhase>,
    admission: RunAdmission,
    lease: Option<Lease>,
    cancellation: CancellationState,
    cancellation_reason: Option<CancellationReason>,
    attempt: u32,
    deadline_at_millis: Option<u64>,
    failure: Option<Failure>,
    result: Option<ResultEnvelope>,
    created_at_millis: u64,
}

impl RunMachine {
    pub fn new(request: RunRequest, created_at_millis: u64) -> Result<Self, RuntimeError> {
        let deadline_at_millis = match request.timeout_millis {
            Some(timeout) => Some(
                created_at_millis
                    .checked_add(timeout)
                    .ok_or_else(|| RuntimeError::invalid("run deadline overflow"))?,
            ),
            None => None,
        };
        Ok(Self {
            admission: RunAdmission::requested(request.idempotency_key.clone()),
            request,
            status: RunStatus::Queued,
            execution_phase: None,
            lease: None,
            cancellation: CancellationState::NotRequested,
            cancellation_reason: None,
            attempt: 1,
            deadline_at_millis,
            failure: None,
            result: None,
            created_at_millis,
        })
    }

    pub fn status(&self) -> RunStatus {
        self.status
    }

    pub fn execution_phase(&self) -> Option<ExecutionPhase> {
        self.execution_phase
    }

    pub fn admission(&self) -> &RunAdmission {
        &self.admission
    }

    pub fn lease(&self) -> Option<&Lease> {
        self.lease.as_ref()
    }

    pub fn cancellation(&self) -> CancellationState {
        self.cancellation
    }

    pub fn cancellation_reason(&self) -> Option<CancellationReason> {
        self.cancellation_reason
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn deadline_at_millis(&self) -> Option<u64> {
        self.deadline_at_millis
    }

    pub fn failure(&self) -> Option<&Failure> {
        self.failure.as_ref()
    }

    pub fn result(&self) -> Option<&ResultEnvelope> {
        self.result.as_ref()
    }

    pub fn created_at_millis(&self) -> u64 {
        self.created_at_millis
    }

    pub fn queue(&mut self) -> Result<(), RuntimeError> {
        if self.status != RunStatus::Queued {
            return Err(RuntimeError::transition("only a queued run can be queued"));
        }
        self.admission.set_queued()
    }

    pub fn reject(&mut self, failure: Failure) -> Result<(), RuntimeError> {
        if self.status != RunStatus::Queued {
            return Err(RuntimeError::transition(
                "only a queued run can be rejected",
            ));
        }
        self.admission.set_rejected(failure.clone())?;
        self.status = RunStatus::Failed;
        self.failure = Some(failure);
        Ok(())
    }

    pub fn coalesce_into(&mut self, run_id: impl Into<String>) -> Result<(), RuntimeError> {
        if self.status != RunStatus::Queued {
            return Err(RuntimeError::transition(
                "only a queued run can be coalesced",
            ));
        }
        self.admission.set_coalesced(bounded_string(
            run_id,
            "coalesced_into_run_id",
            MAX_IDENTITY_PART_BYTES,
        )?)?;
        self.status = RunStatus::Succeeded;
        Ok(())
    }

    pub fn skip(&mut self) -> Result<(), RuntimeError> {
        if self.status != RunStatus::Queued {
            return Err(RuntimeError::transition("only a queued run can be skipped"));
        }
        self.admission.set_skipped()?;
        self.status = RunStatus::Succeeded;
        Ok(())
    }

    pub fn admit(&mut self, lease: Lease, now_millis: u64) -> Result<(), RuntimeError> {
        if self.status != RunStatus::Queued {
            return Err(RuntimeError::transition(
                "only a queued run can be admitted",
            ));
        }
        if !lease.valid_at(now_millis) {
            return Err(RuntimeError::lease_expired());
        }
        self.admission.set_admitted()?;
        self.lease = Some(lease);
        Ok(())
    }

    fn assert_fence(&self, fence: &FenceToken, now_millis: u64) -> Result<(), RuntimeError> {
        let lease = self
            .lease
            .as_ref()
            .ok_or_else(|| RuntimeError::fence("run has no execution lease"))?;
        lease.assert_matches(fence, now_millis)
    }

    fn assert_fence_token(&self, fence: &FenceToken) -> Result<(), RuntimeError> {
        let lease = self
            .lease
            .as_ref()
            .ok_or_else(|| RuntimeError::fence("run has no execution lease"))?;
        if lease.fence != *fence {
            return Err(RuntimeError::fence("fence token does not own the run"));
        }
        Ok(())
    }

    fn ensure_running(&self) -> Result<(), RuntimeError> {
        if self.status == RunStatus::Running {
            Ok(())
        } else if self.status.is_terminal() {
            Err(RuntimeError::terminal())
        } else {
            Err(RuntimeError::transition("run is not running"))
        }
    }

    fn check_deadline(&mut self, now_millis: u64) -> Result<(), RuntimeError> {
        if self
            .deadline_at_millis
            .is_some_and(|deadline| now_millis >= deadline)
        {
            self.status = RunStatus::TimedOut;
            self.execution_phase = None;
            let failure = Failure::timed_out();
            self.failure = Some(failure.clone());
            self.result =
                ResultEnvelope::failure(failure, "", "", self.request.output_limits.clone()).ok();
            return Err(RuntimeError::new(
                "timed_out",
                FailureCategory::TimedOut,
                "run exceeded its execution deadline",
            ));
        }
        Ok(())
    }

    pub fn start(&mut self, fence: &FenceToken, now_millis: u64) -> Result<(), RuntimeError> {
        if self.status != RunStatus::Queued {
            return Err(RuntimeError::transition("only a queued run can start"));
        }
        if self.admission.state() != AdmissionState::Admitted {
            return Err(RuntimeError::transition(
                "run must be admitted before it starts",
            ));
        }
        self.assert_fence(fence, now_millis)?;
        self.check_deadline(now_millis)?;
        self.status = RunStatus::Running;
        self.execution_phase = Some(ExecutionPhase::Executing);
        Ok(())
    }

    pub fn wait_for_network(
        &mut self,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        self.ensure_running()?;
        self.assert_fence(fence, now_millis)?;
        self.check_deadline(now_millis)?;
        self.execution_phase = Some(ExecutionPhase::WaitingForNetwork);
        Ok(())
    }

    pub fn resume_network(
        &mut self,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        self.ensure_running()?;
        self.assert_fence(fence, now_millis)?;
        self.check_deadline(now_millis)?;
        self.execution_phase = Some(ExecutionPhase::Executing);
        Ok(())
    }

    pub fn renew_lease(
        &mut self,
        fence: &FenceToken,
        now_millis: u64,
        ttl_millis: u64,
    ) -> Result<(), RuntimeError> {
        let lease = self
            .lease
            .as_ref()
            .ok_or_else(|| RuntimeError::fence("run has no execution lease"))?;
        lease.assert_matches(fence, now_millis)?;
        self.lease = Some(lease.renew(now_millis, ttl_millis)?);
        Ok(())
    }

    pub fn request_cancel(&mut self, reason: CancellationReason) -> Result<(), RuntimeError> {
        if self.status.is_terminal() {
            return Err(RuntimeError::terminal());
        }
        self.cancellation = CancellationState::Requested;
        self.cancellation_reason = Some(reason);
        Ok(())
    }

    pub fn cancel(&mut self, fence: &FenceToken, now_millis: u64) -> Result<(), RuntimeError> {
        if self.status == RunStatus::Queued {
            if let Some(lease) = self.lease.as_ref() {
                lease.assert_matches(fence, now_millis)?;
            }
        } else {
            self.ensure_running()?;
            self.assert_fence_token(fence)?;
        }
        let reason = self
            .cancellation_reason
            .unwrap_or(CancellationReason::ClientRequest);
        let failure = Failure::cancelled(reason);
        self.status = RunStatus::Cancelled;
        self.execution_phase = None;
        self.failure = Some(failure.clone());
        self.result =
            ResultEnvelope::failure(failure, "", "", self.request.output_limits.clone()).ok();
        Ok(())
    }

    pub fn timeout(&mut self, fence: &FenceToken, now_millis: u64) -> Result<(), RuntimeError> {
        if self.status.is_terminal() {
            return Err(RuntimeError::terminal());
        }
        self.assert_fence_token(fence)?;
        if self
            .deadline_at_millis
            .is_some_and(|deadline| now_millis < deadline)
        {
            return Err(RuntimeError::invalid("run timeout is before its deadline"));
        }
        let failure = Failure::timed_out();
        self.status = RunStatus::TimedOut;
        self.execution_phase = None;
        self.failure = Some(failure.clone());
        self.result =
            ResultEnvelope::failure(failure, "", "", self.request.output_limits.clone()).ok();
        Ok(())
    }

    pub fn succeed(
        &mut self,
        fence: &FenceToken,
        result: ResultEnvelope,
    ) -> Result<(), RuntimeError> {
        self.ensure_running()?;
        self.assert_fence_token(fence)?;
        if result.status != RunStatus::Succeeded {
            return Err(RuntimeError::invalid(
                "success transition requires a succeeded result",
            ));
        }
        self.status = RunStatus::Succeeded;
        self.execution_phase = None;
        self.failure = None;
        self.result = Some(result);
        Ok(())
    }

    pub fn fail(&mut self, fence: &FenceToken, mut failure: Failure) -> Result<(), RuntimeError> {
        self.ensure_running()?;
        self.assert_fence_token(fence)?;
        failure.attempt = Some(self.attempt);
        self.status = RunStatus::Failed;
        self.execution_phase = None;
        self.failure = Some(failure.clone());
        self.result =
            ResultEnvelope::failure(failure, "", "", self.request.output_limits.clone()).ok();
        Ok(())
    }

    pub fn schedule_retry(&mut self, now_millis: u64) -> Result<RetrySchedule, RuntimeError> {
        if self.status != RunStatus::Failed {
            return Err(RuntimeError::transition("only failed runs can be retried"));
        }
        let failure = self
            .failure
            .as_ref()
            .ok_or_else(|| RuntimeError::transition("failed run has no failure"))?;
        if !self.request.retry_policy.allows(failure) {
            return Err(RuntimeError::new(
                "retry_not_allowed",
                FailureCategory::Conflict,
                "failure category is not retryable",
            ));
        }
        if self.attempt >= self.request.retry_policy.max_attempts {
            return Err(RuntimeError::new(
                "retry_exhausted",
                FailureCategory::RetryExhausted,
                "run retry budget is exhausted",
            ));
        }
        let delay_millis = self.request.retry_policy.delay_for_attempt(self.attempt);
        let next_attempt_at_millis = now_millis
            .checked_add(delay_millis)
            .ok_or_else(|| RuntimeError::invalid("retry schedule overflow"))?;
        self.attempt += 1;
        self.status = RunStatus::Queued;
        self.execution_phase = None;
        self.admission = RunAdmission {
            state: AdmissionState::Queued,
            idempotency_key: self.request.idempotency_key.clone(),
            coalesced_into_run_id: None,
            failure: None,
        };
        self.lease = None;
        self.cancellation = CancellationState::NotRequested;
        self.cancellation_reason = None;
        self.failure = None;
        self.result = None;
        self.deadline_at_millis = self
            .request
            .timeout_millis
            .and_then(|timeout| next_attempt_at_millis.checked_add(timeout));
        Ok(RetrySchedule {
            attempt: self.attempt,
            delay_millis,
            next_attempt_at_millis,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationStatus {
    Active,
    Paused,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationConcurrencyPolicy {
    CoalesceIfActive,
    AlwaysEnqueue,
    SkipIfActive,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationCatchUpPolicy {
    SkipMissed,
    EnqueueMissedWithCap,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationOutputMode {
    TrackIssue,
    ChatOutput,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationTriggerKind {
    Schedule,
    Webhook,
    Api,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunSource {
    Schedule,
    Manual,
    Api,
    Webhook,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Received,
    Running,
    Coalesced,
    Skipped,
    IssueCreated,
    Completed,
    Failed,
}

impl AutomationRunStatus {
    fn is_live(self) -> bool {
        matches!(self, Self::Received | Self::Running | Self::IssueCreated)
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Coalesced | Self::Skipped | Self::Completed | Self::Failed
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDefinition {
    pub org_id: String,
    pub automation_id: String,
    pub status: AutomationStatus,
    pub concurrency_policy: AutomationConcurrencyPolicy,
    pub catch_up_policy: AutomationCatchUpPolicy,
    pub output_mode: AutomationOutputMode,
}

impl AutomationDefinition {
    pub fn new(
        org_id: impl Into<String>,
        automation_id: impl Into<String>,
        status: AutomationStatus,
        concurrency_policy: AutomationConcurrencyPolicy,
        catch_up_policy: AutomationCatchUpPolicy,
        output_mode: AutomationOutputMode,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            org_id: bounded_string(org_id, "org_id", MAX_IDENTITY_PART_BYTES)?,
            automation_id: bounded_string(automation_id, "automation_id", MAX_IDENTITY_PART_BYTES)?,
            status,
            concurrency_policy,
            catch_up_policy,
            output_mode,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRequest {
    pub run_id: String,
    pub trigger_id: Option<String>,
    pub source: AutomationRunSource,
    pub idempotency_key: Option<String>,
    pub payload: Option<Value>,
    pub triggered_at_millis: u64,
}

impl AutomationRunRequest {
    pub fn new(
        run_id: impl Into<String>,
        trigger_id: Option<&str>,
        source: AutomationRunSource,
        idempotency_key: Option<&str>,
        payload: Option<Value>,
        triggered_at_millis: u64,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            trigger_id: trigger_id.map(str::to_owned),
            source,
            idempotency_key: idempotency_key.map(str::to_owned),
            payload,
            triggered_at_millis,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub org_id: String,
    pub automation_id: String,
    pub trigger_id: Option<String>,
    pub source: AutomationRunSource,
    pub status: AutomationRunStatus,
    pub triggered_at_millis: u64,
    pub idempotency_key: Option<String>,
    pub trigger_payload: Option<Value>,
    pub coalesced_into_run_id: Option<String>,
    pub failure_reason: Option<String>,
    pub completed_at_millis: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationDispatch {
    Created {
        run_id: String,
        status: AutomationRunStatus,
    },
    Replay {
        run_id: String,
    },
    Coalesced {
        run_id: String,
        coalesced_into_run_id: String,
    },
    Skipped {
        run_id: String,
        active_run_id: String,
    },
}

impl AutomationDispatch {
    pub fn run_id(&self) -> &str {
        match self {
            Self::Created { run_id, .. }
            | Self::Replay { run_id }
            | Self::Coalesced { run_id, .. }
            | Self::Skipped { run_id, .. } => run_id,
        }
    }

    pub fn status(&self) -> AutomationRunStatus {
        match self {
            Self::Created { status, .. } => *status,
            Self::Replay { .. } => AutomationRunStatus::Received,
            Self::Coalesced { .. } => AutomationRunStatus::Coalesced,
            Self::Skipped { .. } => AutomationRunStatus::Skipped,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchUpPlan {
    pub enqueued: usize,
    pub skipped: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct AutomationScheduler {
    pub definition: Option<AutomationDefinition>,
    runs: BTreeMap<String, AutomationRun>,
}

impl AutomationScheduler {
    pub fn new(definition: AutomationDefinition) -> Self {
        Self {
            definition: Some(definition),
            runs: BTreeMap::new(),
        }
    }

    fn definition(&self) -> Result<&AutomationDefinition, RuntimeError> {
        self.definition
            .as_ref()
            .ok_or_else(|| RuntimeError::invalid("automation definition is missing"))
    }

    pub fn dispatch(
        &mut self,
        request: AutomationRunRequest,
    ) -> Result<AutomationDispatch, RuntimeError> {
        let definition = self.definition()?.clone();
        if definition.status != AutomationStatus::Active {
            return Err(RuntimeError::new(
                "automation_not_active",
                FailureCategory::AdmissionRejected,
                "automation is not active",
            ));
        }
        let run_id = bounded_string(request.run_id, "automation_run_id", MAX_IDENTITY_PART_BYTES)?;
        let trigger_id = request
            .trigger_id
            .map(|value| bounded_string(value, "trigger_id", MAX_IDENTITY_PART_BYTES))
            .transpose()?;
        let idempotency_key = request
            .idempotency_key
            .map(|value| bounded_string(value, "idempotency_key", MAX_IDEMPOTENCY_KEY_BYTES))
            .transpose()?;

        if let Some(existing) = self.runs.values().find(|run| {
            run.org_id == definition.org_id
                && run.automation_id == definition.automation_id
                && run.trigger_id == trigger_id
                && run.source == request.source
                && idempotency_key.is_some()
                && run.idempotency_key == idempotency_key
        }) {
            return Ok(AutomationDispatch::Replay {
                run_id: existing.id.clone(),
            });
        }

        let active_run_id = self
            .runs
            .values()
            .find(|run| run.status.is_live())
            .map(|run| run.id.clone());
        let mut run = AutomationRun {
            id: run_id.clone(),
            org_id: definition.org_id,
            automation_id: definition.automation_id,
            trigger_id,
            source: request.source,
            status: AutomationRunStatus::Received,
            triggered_at_millis: request.triggered_at_millis,
            idempotency_key,
            trigger_payload: request.payload,
            coalesced_into_run_id: None,
            failure_reason: None,
            completed_at_millis: None,
        };
        if let Some(active_run_id) = active_run_id {
            match definition.concurrency_policy {
                AutomationConcurrencyPolicy::AlwaysEnqueue => {}
                AutomationConcurrencyPolicy::CoalesceIfActive => {
                    run.status = AutomationRunStatus::Coalesced;
                    run.coalesced_into_run_id = Some(active_run_id.clone());
                    run.completed_at_millis = Some(run.triggered_at_millis);
                    self.runs.insert(run_id.clone(), run);
                    return Ok(AutomationDispatch::Coalesced {
                        run_id,
                        coalesced_into_run_id: active_run_id,
                    });
                }
                AutomationConcurrencyPolicy::SkipIfActive => {
                    run.status = AutomationRunStatus::Skipped;
                    run.coalesced_into_run_id = Some(active_run_id.clone());
                    run.completed_at_millis = Some(run.triggered_at_millis);
                    self.runs.insert(run_id.clone(), run);
                    return Ok(AutomationDispatch::Skipped {
                        run_id,
                        active_run_id,
                    });
                }
            }
        }
        let status = run.status;
        self.runs.insert(run_id.clone(), run);
        Ok(AutomationDispatch::Created { run_id, status })
    }

    pub fn run(&self, run_id: &str) -> Option<&AutomationRun> {
        self.runs.get(run_id)
    }

    pub fn start(&mut self, run_id: &str) -> Result<AutomationRunStatus, RuntimeError> {
        let output_mode = self.definition()?.output_mode;
        let run = self
            .runs
            .get_mut(run_id)
            .ok_or_else(|| RuntimeError::invalid("automation run not found"))?;
        if run.status != AutomationRunStatus::Received {
            return Err(RuntimeError::transition(
                "only received automation runs can start",
            ));
        }
        run.status = match output_mode {
            AutomationOutputMode::ChatOutput => AutomationRunStatus::Running,
            AutomationOutputMode::TrackIssue => AutomationRunStatus::IssueCreated,
        };
        Ok(run.status)
    }

    pub fn complete(&mut self, run_id: &str, completed_at_millis: u64) -> Result<(), RuntimeError> {
        let run = self
            .runs
            .get_mut(run_id)
            .ok_or_else(|| RuntimeError::invalid("automation run not found"))?;
        if !run.status.is_live() {
            return Err(RuntimeError::transition("automation run is not live"));
        }
        run.status = AutomationRunStatus::Completed;
        run.completed_at_millis = Some(completed_at_millis);
        Ok(())
    }

    pub fn fail(
        &mut self,
        run_id: &str,
        failure_reason: impl Into<String>,
        completed_at_millis: u64,
    ) -> Result<(), RuntimeError> {
        let run = self
            .runs
            .get_mut(run_id)
            .ok_or_else(|| RuntimeError::invalid("automation run not found"))?;
        if !run.status.is_live() {
            return Err(RuntimeError::transition("automation run is not live"));
        }
        run.status = AutomationRunStatus::Failed;
        run.failure_reason = Some(bounded_string(
            failure_reason,
            "failure_reason",
            MAX_FAILURE_SUMMARY_BYTES,
        )?);
        run.completed_at_millis = Some(completed_at_millis);
        Ok(())
    }

    pub fn catch_up(&self, missed_count: usize) -> CatchUpPlan {
        match self
            .definition
            .as_ref()
            .map(|definition| definition.catch_up_policy)
        {
            Some(AutomationCatchUpPolicy::EnqueueMissedWithCap) => CatchUpPlan {
                enqueued: missed_count.min(MAX_AUTOMATION_CATCH_UP_RUNS),
                skipped: missed_count.saturating_sub(MAX_AUTOMATION_CATCH_UP_RUNS),
            },
            Some(AutomationCatchUpPolicy::SkipMissed) | None => CatchUpPlan {
                enqueued: 0,
                skipped: missed_count,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatGenerationStatus {
    Starting,
    Active,
    Running,
    WaitingForNetwork,
    ToolBusy,
    Closing,
    StopRequested,
    Stopping,
    Completed,
    Failed,
    Stopped,
    Aborted,
    InterruptedUnverified,
    ControlLost,
}

impl ChatGenerationStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::Failed
                | Self::Stopped
                | Self::Aborted
                | Self::InterruptedUnverified
                | Self::ControlLost
        )
    }

    fn is_live(self) -> bool {
        !self.is_terminal()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatGenerationControlState {
    Unregistered,
    Ready,
    Stopping,
    Terminal,
    ControlLost,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatQueueStatus {
    Queued,
    SteerPending,
    AcceptedCurrent,
    AcceptanceUnknown,
    ContinuationPending,
    DequeueClaimed,
    Delivered,
    FailedActionable,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatDeliveryIntent {
    Queue,
    Steer,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatContinuationReason {
    Closing,
    Unsupported,
    RegistrationTimeout,
    OwnerChangedBeforeSend,
    GenerationFenceChanged,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatSteerResult {
    DeliveredCurrent,
    ScheduledNext,
    AcceptanceUnknown,
    FailedActionable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatSteerDecision {
    ProviderDispatchRequired {
        item_id: String,
    },
    ContinuationRequired {
        item_id: String,
        reason: ChatContinuationReason,
    },
    StaleGeneration {
        active_generation_id: Option<String>,
    },
    ProviderSendInFlight {
        item_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGenerationRequest {
    pub generation_id: String,
    pub attempt_epoch: u64,
    pub owner_lease: Lease,
    pub started_at_millis: u64,
}

impl ChatGenerationRequest {
    pub fn new(
        generation_id: impl Into<String>,
        attempt_epoch: u64,
        owner_lease: Lease,
        started_at_millis: u64,
    ) -> Self {
        Self {
            generation_id: generation_id.into(),
            attempt_epoch,
            owner_lease,
            started_at_millis,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGeneration {
    pub generation_id: String,
    pub conversation_id: String,
    pub attempt_epoch: u64,
    pub status: ChatGenerationStatus,
    pub control_state: ChatGenerationControlState,
    pub control_version: u64,
    pub owner_lease: Lease,
    pub provider_thread_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub started_at_millis: u64,
    pub completed_at_millis: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSteerRequest {
    pub item_id: String,
    pub client_mutation_id: String,
    pub body: String,
    pub expected_generation_id: String,
    pub expected_attempt_epoch: u64,
}

impl ChatSteerRequest {
    pub fn new(
        item_id: impl Into<String>,
        client_mutation_id: impl Into<String>,
        body: impl Into<String>,
        expected_generation_id: impl Into<String>,
        expected_attempt_epoch: u64,
    ) -> Self {
        Self {
            item_id: item_id.into(),
            client_mutation_id: client_mutation_id.into(),
            body: body.into(),
            expected_generation_id: expected_generation_id.into(),
            expected_attempt_epoch,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQueueRequest {
    pub item_id: String,
    pub client_mutation_id: String,
    pub body: String,
    pub created_at_millis: u64,
}

impl ChatQueueRequest {
    pub fn new(
        item_id: impl Into<String>,
        client_mutation_id: impl Into<String>,
        body: impl Into<String>,
        created_at_millis: u64,
    ) -> Self {
        Self {
            item_id: item_id.into(),
            client_mutation_id: client_mutation_id.into(),
            body: body.into(),
            created_at_millis,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQueueItem {
    pub item_id: String,
    pub conversation_id: String,
    pub position: u64,
    pub version: u64,
    pub client_mutation_id: String,
    pub body: String,
    pub status: ChatQueueStatus,
    pub delivery_intent: ChatDeliveryIntent,
    pub expected_generation_id: Option<String>,
    pub attempt_epoch: Option<u64>,
    pub provider_client_message_id: Option<String>,
    pub delivery_lease: Option<Lease>,
    pub delivery_attempts: u32,
    pub created_at_millis: u64,
    pub delivered_at_millis: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEnqueueResult {
    pub item_id: String,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatClaim {
    pub item_id: String,
    pub delivery_lease: Lease,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatScheduler {
    org_id: String,
    conversation_id: String,
    active_generation: Option<ChatGeneration>,
    items: BTreeMap<String, ChatQueueItem>,
    next_position: u64,
}

impl ChatScheduler {
    pub fn new(
        org_id: impl Into<String>,
        conversation_id: impl Into<String>,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            org_id: bounded_string(org_id, "org_id", MAX_IDENTITY_PART_BYTES)?,
            conversation_id: bounded_string(
                conversation_id,
                "conversation_id",
                MAX_IDENTITY_PART_BYTES,
            )?,
            active_generation: None,
            items: BTreeMap::new(),
            next_position: 1,
        })
    }

    pub fn active_generation(&self) -> Option<&ChatGeneration> {
        self.active_generation.as_ref()
    }

    pub fn item(&self, item_id: &str) -> Option<&ChatQueueItem> {
        self.items.get(item_id)
    }

    fn check_generation_fence(
        generation: &ChatGeneration,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        generation.owner_lease.assert_matches(fence, now_millis)
    }

    pub fn register_generation(
        &mut self,
        request: ChatGenerationRequest,
    ) -> Result<(), RuntimeError> {
        let generation_id = bounded_string(
            request.generation_id,
            "generation_id",
            MAX_IDENTITY_PART_BYTES,
        )?;
        if request.attempt_epoch == 0 || request.owner_lease.fence.epoch == 0 {
            return Err(RuntimeError::invalid(
                "generation attempt epoch must be greater than zero",
            ));
        }
        if self
            .active_generation
            .as_ref()
            .is_some_and(|generation| generation.status.is_live())
        {
            return Err(RuntimeError::new(
                "generation_active",
                FailureCategory::Conflict,
                "conversation already has an active generation",
            ));
        }
        self.active_generation = Some(ChatGeneration {
            generation_id,
            conversation_id: self.conversation_id.clone(),
            attempt_epoch: request.attempt_epoch,
            status: ChatGenerationStatus::Starting,
            control_state: ChatGenerationControlState::Unregistered,
            control_version: 1,
            owner_lease: request.owner_lease,
            provider_thread_id: None,
            provider_turn_id: None,
            started_at_millis: request.started_at_millis,
            completed_at_millis: None,
        });
        Ok(())
    }

    pub fn mark_generation_ready(
        &mut self,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        let generation = self
            .active_generation
            .as_mut()
            .ok_or_else(|| RuntimeError::invalid("active generation not found"))?;
        Self::check_generation_fence(generation, fence, now_millis)?;
        if generation.status.is_terminal() {
            return Err(RuntimeError::terminal());
        }
        generation.control_state = ChatGenerationControlState::Ready;
        generation.control_version += 1;
        if generation.status == ChatGenerationStatus::Starting {
            generation.status = ChatGenerationStatus::Active;
        }
        Ok(())
    }

    pub fn mark_generation_running(
        &mut self,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        let generation = self
            .active_generation
            .as_mut()
            .ok_or_else(|| RuntimeError::invalid("active generation not found"))?;
        Self::check_generation_fence(generation, fence, now_millis)?;
        if generation.status.is_terminal() {
            return Err(RuntimeError::terminal());
        }
        if generation.control_state != ChatGenerationControlState::Ready {
            return Err(RuntimeError::transition("generation control is not ready"));
        }
        generation.status = ChatGenerationStatus::Running;
        generation.control_version += 1;
        Ok(())
    }

    pub fn request_stop(
        &mut self,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        let generation = self
            .active_generation
            .as_mut()
            .ok_or_else(|| RuntimeError::invalid("active generation not found"))?;
        Self::check_generation_fence(generation, fence, now_millis)?;
        if generation.status.is_terminal() {
            return Err(RuntimeError::terminal());
        }
        generation.status = ChatGenerationStatus::Stopping;
        generation.control_state = ChatGenerationControlState::Stopping;
        generation.control_version += 1;
        Ok(())
    }

    pub fn mark_generation_terminal(
        &mut self,
        status: ChatGenerationStatus,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        if !status.is_terminal() {
            return Err(RuntimeError::invalid(
                "chat generation status is not terminal",
            ));
        }
        let generation = self
            .active_generation
            .as_mut()
            .ok_or_else(|| RuntimeError::invalid("active generation not found"))?;
        Self::check_generation_fence(generation, fence, now_millis)?;
        generation.status = status;
        generation.control_state = if status == ChatGenerationStatus::ControlLost {
            ChatGenerationControlState::ControlLost
        } else {
            ChatGenerationControlState::Terminal
        };
        generation.control_version += 1;
        generation.completed_at_millis = Some(now_millis);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_item(
        &mut self,
        item_id: String,
        client_mutation_id: String,
        body: String,
        status: ChatQueueStatus,
        delivery_intent: ChatDeliveryIntent,
        expected_generation_id: Option<String>,
        attempt_epoch: Option<u64>,
        created_at_millis: u64,
    ) -> Result<(), RuntimeError> {
        if self.items.contains_key(&item_id) {
            return Err(RuntimeError::new(
                "duplicate_queue_item",
                FailureCategory::Conflict,
                "chat queue item id already exists",
            ));
        }
        let item_id = bounded_string(item_id, "queue_item_id", MAX_IDENTITY_PART_BYTES)?;
        let client_mutation_id = bounded_string(
            client_mutation_id,
            "client_mutation_id",
            MAX_IDEMPOTENCY_KEY_BYTES,
        )?;
        let body = bounded_string(body, "chat_body", 256 * 1024)?;
        self.items.insert(
            item_id.clone(),
            ChatQueueItem {
                item_id,
                conversation_id: self.conversation_id.clone(),
                position: self.next_position,
                version: 1,
                client_mutation_id,
                body,
                status,
                delivery_intent,
                expected_generation_id,
                attempt_epoch,
                provider_client_message_id: None,
                delivery_lease: None,
                delivery_attempts: 0,
                created_at_millis,
                delivered_at_millis: None,
            },
        );
        self.next_position += 1;
        Ok(())
    }

    pub fn enqueue(
        &mut self,
        request: ChatQueueRequest,
    ) -> Result<ChatEnqueueResult, RuntimeError> {
        let client_mutation_id = bounded_string(
            request.client_mutation_id,
            "client_mutation_id",
            MAX_IDEMPOTENCY_KEY_BYTES,
        )?;
        if let Some(existing) = self
            .items
            .values()
            .find(|item| item.client_mutation_id == client_mutation_id)
        {
            return Ok(ChatEnqueueResult {
                item_id: existing.item_id.clone(),
                duplicate: true,
            });
        }
        let item_id = bounded_string(request.item_id, "queue_item_id", MAX_IDENTITY_PART_BYTES)?;
        self.insert_item(
            item_id.clone(),
            client_mutation_id,
            request.body,
            ChatQueueStatus::Queued,
            ChatDeliveryIntent::Queue,
            None,
            None,
            request.created_at_millis,
        )?;
        Ok(ChatEnqueueResult {
            item_id,
            duplicate: false,
        })
    }

    pub fn request_steer(
        &mut self,
        request: ChatSteerRequest,
    ) -> Result<ChatSteerDecision, RuntimeError> {
        let item_id = bounded_string(request.item_id, "queue_item_id", MAX_IDENTITY_PART_BYTES)?;
        let client_mutation_id = bounded_string(
            request.client_mutation_id,
            "client_mutation_id",
            MAX_IDEMPOTENCY_KEY_BYTES,
        )?;
        let body = bounded_string(request.body, "chat_body", 256 * 1024)?;
        if self.items.contains_key(&item_id) {
            return Ok(ChatSteerDecision::ProviderSendInFlight { item_id });
        }
        let Some(generation) = self.active_generation.clone() else {
            return Ok(ChatSteerDecision::StaleGeneration {
                active_generation_id: None,
            });
        };
        if generation.generation_id != request.expected_generation_id {
            return Ok(ChatSteerDecision::StaleGeneration {
                active_generation_id: Some(generation.generation_id),
            });
        }
        if generation.attempt_epoch != request.expected_attempt_epoch {
            self.insert_item(
                item_id.clone(),
                client_mutation_id,
                body,
                ChatQueueStatus::ContinuationPending,
                ChatDeliveryIntent::Steer,
                Some(request.expected_generation_id),
                Some(request.expected_attempt_epoch),
                generation.started_at_millis,
            )?;
            return Ok(ChatSteerDecision::ContinuationRequired {
                item_id,
                reason: ChatContinuationReason::GenerationFenceChanged,
            });
        }
        if matches!(
            generation.status,
            ChatGenerationStatus::Closing
                | ChatGenerationStatus::StopRequested
                | ChatGenerationStatus::Stopping
        ) {
            self.insert_item(
                item_id.clone(),
                client_mutation_id,
                body,
                ChatQueueStatus::ContinuationPending,
                ChatDeliveryIntent::Steer,
                Some(request.expected_generation_id),
                Some(request.expected_attempt_epoch),
                generation.started_at_millis,
            )?;
            return Ok(ChatSteerDecision::ContinuationRequired {
                item_id,
                reason: ChatContinuationReason::Closing,
            });
        }
        if generation.status != ChatGenerationStatus::Running
            || generation.control_state != ChatGenerationControlState::Ready
        {
            self.insert_item(
                item_id.clone(),
                client_mutation_id,
                body,
                ChatQueueStatus::ContinuationPending,
                ChatDeliveryIntent::Steer,
                Some(request.expected_generation_id),
                Some(request.expected_attempt_epoch),
                generation.started_at_millis,
            )?;
            return Ok(ChatSteerDecision::ContinuationRequired {
                item_id,
                reason: ChatContinuationReason::RegistrationTimeout,
            });
        }
        self.insert_item(
            item_id.clone(),
            client_mutation_id,
            body,
            ChatQueueStatus::SteerPending,
            ChatDeliveryIntent::Steer,
            Some(request.expected_generation_id),
            Some(request.expected_attempt_epoch),
            generation.started_at_millis,
        )?;
        Ok(ChatSteerDecision::ProviderDispatchRequired { item_id })
    }

    pub fn record_steer_provider_sent(
        &mut self,
        item_id: &str,
        fence: &FenceToken,
        provider_client_message_id: impl Into<String>,
    ) -> Result<(), RuntimeError> {
        let generation = self
            .active_generation
            .as_ref()
            .ok_or_else(|| RuntimeError::fence("active generation is missing"))?;
        Self::check_generation_fence(generation, fence, generation.started_at_millis)?;
        let item = self
            .items
            .get_mut(item_id)
            .ok_or_else(|| RuntimeError::invalid("chat queue item not found"))?;
        if item.status != ChatQueueStatus::SteerPending {
            return Err(RuntimeError::transition("chat steer is not pending"));
        }
        item.provider_client_message_id = Some(bounded_string(
            provider_client_message_id,
            "provider_client_message_id",
            MAX_IDEMPOTENCY_KEY_BYTES,
        )?);
        item.status = ChatQueueStatus::AcceptedCurrent;
        item.version += 1;
        Ok(())
    }

    pub fn record_steer_acknowledged(
        &mut self,
        item_id: &str,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<ChatSteerResult, RuntimeError> {
        let generation = self
            .active_generation
            .as_ref()
            .ok_or_else(|| RuntimeError::fence("active generation is missing"))?;
        Self::check_generation_fence(generation, fence, now_millis)?;
        let item = self
            .items
            .get_mut(item_id)
            .ok_or_else(|| RuntimeError::invalid("chat queue item not found"))?;
        if item.status != ChatQueueStatus::AcceptedCurrent {
            return Err(RuntimeError::transition(
                "chat steer has not been provider-accepted",
            ));
        }
        if generation.generation_id == item.expected_generation_id.as_deref().unwrap_or_default()
            && generation.attempt_epoch == item.attempt_epoch.unwrap_or_default()
            && generation.status == ChatGenerationStatus::Running
        {
            item.status = ChatQueueStatus::Delivered;
            item.delivered_at_millis = Some(now_millis);
            item.version += 1;
            Ok(ChatSteerResult::DeliveredCurrent)
        } else {
            item.status = ChatQueueStatus::AcceptanceUnknown;
            item.version += 1;
            Ok(ChatSteerResult::AcceptanceUnknown)
        }
    }

    pub fn record_steer_acceptance_unknown(
        &mut self,
        item_id: &str,
    ) -> Result<ChatSteerResult, RuntimeError> {
        let item = self
            .items
            .get_mut(item_id)
            .ok_or_else(|| RuntimeError::invalid("chat queue item not found"))?;
        if !matches!(
            item.status,
            ChatQueueStatus::SteerPending | ChatQueueStatus::AcceptedCurrent
        ) {
            return Err(RuntimeError::transition("chat steer is not in flight"));
        }
        item.status = ChatQueueStatus::AcceptanceUnknown;
        item.version += 1;
        Ok(ChatSteerResult::AcceptanceUnknown)
    }

    pub fn claim_next(
        &mut self,
        delivery_lease: Lease,
        now_millis: u64,
    ) -> Result<Option<ChatClaim>, RuntimeError> {
        if !delivery_lease.valid_at(now_millis) {
            return Err(RuntimeError::lease_expired());
        }
        let item_id = self
            .items
            .values()
            .filter(|item| {
                matches!(
                    item.status,
                    ChatQueueStatus::Queued | ChatQueueStatus::ContinuationPending
                )
            })
            .min_by_key(|item| item.position)
            .map(|item| item.item_id.clone());
        let Some(item_id) = item_id else {
            return Ok(None);
        };
        let item = self
            .items
            .get_mut(&item_id)
            .ok_or_else(|| RuntimeError::invalid("chat queue item not found"))?;
        item.status = ChatQueueStatus::DequeueClaimed;
        item.delivery_lease = Some(delivery_lease.clone());
        item.delivery_attempts += 1;
        item.version += 1;
        Ok(Some(ChatClaim {
            item_id,
            delivery_lease,
        }))
    }

    pub fn acknowledge_delivery(
        &mut self,
        item_id: &str,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), RuntimeError> {
        let item = self
            .items
            .get_mut(item_id)
            .ok_or_else(|| RuntimeError::invalid("chat queue item not found"))?;
        let lease = item
            .delivery_lease
            .as_ref()
            .ok_or_else(|| RuntimeError::fence("chat queue item has no delivery lease"))?;
        lease.assert_matches(fence, now_millis)?;
        if item.status != ChatQueueStatus::DequeueClaimed {
            return Err(RuntimeError::transition("chat queue item is not claimed"));
        }
        item.status = ChatQueueStatus::Delivered;
        item.delivered_at_millis = Some(now_millis);
        item.version += 1;
        Ok(())
    }
}
