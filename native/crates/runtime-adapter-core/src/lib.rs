//! Typed, side-effect-free translation between `runtime-core` run state and the
//! `rudder-process-host` JSON protocol.
//!
//! This crate intentionally does not spawn processes or persist state. The Node
//! runtime remains the authority for product state; this adapter only carries
//! the identity and lease boundary across the native helper boundary and maps
//! the helper's terminal receipt back to a bounded runtime outcome.

use rudder_native_protocol::{Command, ProtocolVersion};
use rudder_runtime_core::{
    AdmissionState, CancellationReason, CancellationState, Failure, FailureCategory, FenceToken,
    Lease, OutputLimits, ResultEnvelope, RunMachine, RunStatus, RuntimeIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

pub const ADAPTER_PROTOCOL_MAJOR: u16 = rudder_native_protocol::PROTOCOL_MAJOR;
pub const ADAPTER_PROTOCOL_MINOR: u16 = rudder_native_protocol::PROTOCOL_MINOR;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterErrorCategory {
    InvalidInput,
    Conflict,
    StaleFence,
    LeaseExpired,
    Cancelled,
    OutputLimit,
    Protocol,
    Terminal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterError {
    code: String,
    category: AdapterErrorCategory,
    message: String,
}

impl AdapterError {
    fn new(
        code: impl Into<String>,
        category: AdapterErrorCategory,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            category,
            message: message.into(),
        }
    }

    fn invalid(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, AdapterErrorCategory::InvalidInput, message)
    }

    fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, AdapterErrorCategory::Conflict, message)
    }

    fn stale(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, AdapterErrorCategory::StaleFence, message)
    }

    fn lease_expired() -> Self {
        Self::new(
            "lease_expired",
            AdapterErrorCategory::LeaseExpired,
            "runtime lease expired",
        )
    }

    fn cancelled(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, AdapterErrorCategory::Cancelled, message)
    }

    fn output_limit(message: impl Into<String>) -> Self {
        Self::new(
            "output_limit_exceeded",
            AdapterErrorCategory::OutputLimit,
            message,
        )
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self::new(
            "protocol_translation_failed",
            AdapterErrorCategory::Protocol,
            message,
        )
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn category(&self) -> AdapterErrorCategory {
        self.category
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AdapterError {}

/// The launch inputs owned by the runtime authority and translated to a
/// `startProcess` process-host command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessLaunch {
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub runtime_root: String,
    pub owner_token: String,
    pub stdin: Option<String>,
    pub grace_ms: Option<u64>,
}

impl ProcessLaunch {
    pub fn new(
        executable: impl Into<String>,
        argv: Vec<String>,
        cwd: impl Into<String>,
        env: BTreeMap<String, String>,
        runtime_root: impl Into<String>,
        owner_token: impl Into<String>,
    ) -> Self {
        Self {
            executable: executable.into(),
            argv,
            cwd: cwd.into(),
            env,
            runtime_root: runtime_root.into(),
            owner_token: owner_token.into(),
            stdin: None,
            grace_ms: None,
        }
    }

    pub fn with_stdin(mut self, stdin: impl Into<String>) -> Self {
        self.stdin = Some(stdin.into());
        self
    }

    pub fn with_grace_ms(mut self, grace_ms: u64) -> Self {
        self.grace_ms = Some(grace_ms);
        self
    }

    fn validate_owner_token(&self) -> Result<(), AdapterError> {
        validate_owner_token_value(&self.owner_token)
    }
}

fn validate_owner_token_value(owner_token: &str) -> Result<(), AdapterError> {
    if owner_token.is_empty()
        || owner_token.len() > 256
        || owner_token == "."
        || owner_token == ".."
        || owner_token.contains('/')
        || owner_token.contains('\\')
        || owner_token.contains('\0')
    {
        return Err(AdapterError::invalid(
            "invalid_owner_token",
            "owner token must be a single safe path component",
        ));
    }
    Ok(())
}

/// A command accepted by `rudder-process-host` for an agent-run process.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProcessHostMessage {
    StartProcess {
        #[serde(rename = "protocolVersion")]
        protocol_version: ProtocolVersion,
        #[serde(rename = "requestId")]
        request_id: String,
        executable: String,
        #[serde(default)]
        argv: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(rename = "ownerToken")]
        owner_token: String,
        #[serde(rename = "runtimeRoot")]
        runtime_root: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stdin: Option<String>,
        #[serde(rename = "graceMs", default, skip_serializing_if = "Option::is_none")]
        grace_ms: Option<u64>,
    },
    Stop {
        #[serde(rename = "protocolVersion")]
        protocol_version: ProtocolVersion,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "graceMs", default, skip_serializing_if = "Option::is_none")]
        grace_ms: Option<u64>,
    },
    Input {
        #[serde(rename = "protocolVersion")]
        protocol_version: ProtocolVersion,
        #[serde(rename = "requestId")]
        request_id: String,
        data: String,
    },
    Resize {
        #[serde(rename = "protocolVersion")]
        protocol_version: ProtocolVersion,
        #[serde(rename = "requestId")]
        request_id: String,
        cols: u16,
        rows: u16,
    },
}

impl ProcessHostMessage {
    fn start_process(request_id: String, launch: &ProcessLaunch) -> Self {
        Self::StartProcess {
            protocol_version: ProtocolVersion::default(),
            request_id,
            executable: launch.executable.clone(),
            argv: launch.argv.clone(),
            cwd: launch.cwd.clone(),
            env: launch.env.clone(),
            owner_token: launch.owner_token.clone(),
            runtime_root: launch.runtime_root.clone(),
            stdin: launch.stdin.clone(),
            grace_ms: launch.grace_ms,
        }
    }

    fn stop(request_id: String, grace_ms: Option<u64>) -> Self {
        Self::Stop {
            protocol_version: ProtocolVersion::default(),
            request_id,
            grace_ms,
        }
    }

    fn input(request_id: String, data: String) -> Self {
        Self::Input {
            protocol_version: ProtocolVersion::default(),
            request_id,
            data,
        }
    }

    fn resize(request_id: String, cols: u16, rows: u16) -> Self {
        Self::Resize {
            protocol_version: ProtocolVersion::default(),
            request_id,
            cols,
            rows,
        }
    }

    /// Validate through the native protocol crate instead of duplicating its
    /// wire limits in this adapter.
    pub fn validate(&self) -> Result<(), AdapterError> {
        if let Self::StartProcess { owner_token, .. } = self {
            validate_owner_token_value(owner_token)?;
        }

        let value = serde_json::to_value(self).map_err(|error| {
            AdapterError::protocol(format!("message serialization failed: {error}"))
        })?;
        let command: Command = serde_json::from_value(value).map_err(|error| {
            AdapterError::protocol(format!("native command translation failed: {error}"))
        })?;
        command.validate().map_err(AdapterError::from_native_code)
    }

    pub fn to_wire_value(&self) -> Result<Value, AdapterError> {
        self.validate()?;
        serde_json::to_value(self).map_err(|error| {
            AdapterError::protocol(format!("message serialization failed: {error}"))
        })
    }
}

impl AdapterError {
    fn from_native_code(code: &'static str) -> Self {
        let category = match code {
            "protocol_version_required"
            | "request_id_required"
            | "protocol_version_mismatch"
            | "invalid_request_id"
            | "invalid_executable"
            | "invalid_cwd"
            | "paths_must_be_absolute"
            | "invalid_arguments"
            | "invalid_environment"
            | "owner_token_required"
            | "invalid_owner_token"
            | "runtime_root_required"
            | "invalid_runtime_root"
            | "stdin_too_large"
            | "invalid_grace_ms"
            | "invalid_terminal_input"
            | "invalid_terminal_size" => AdapterErrorCategory::InvalidInput,
            _ => AdapterErrorCategory::Protocol,
        };
        Self::new(
            code,
            category,
            format!("native protocol rejected command: {code}"),
        )
    }
}

/// A host command with the runtime identity and fence that authorized it.
/// `to_wire_value` keeps the host command at the top level and attaches the
/// binding as ignored metadata, so an older host can consume the same command
/// without losing the authority context held by the adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundProcessHostMessage {
    identity: RuntimeIdentity,
    lease: Lease,
    fence: FenceToken,
    attempt: u32,
    cancellation_reason: Option<CancellationReason>,
    message: ProcessHostMessage,
}

impl BoundProcessHostMessage {
    fn new(
        identity: RuntimeIdentity,
        lease: Lease,
        fence: FenceToken,
        attempt: u32,
        cancellation_reason: Option<CancellationReason>,
        message: ProcessHostMessage,
    ) -> Result<Self, AdapterError> {
        message.validate()?;
        Ok(Self {
            identity,
            lease,
            fence,
            attempt,
            cancellation_reason,
            message,
        })
    }

    pub fn identity(&self) -> &RuntimeIdentity {
        &self.identity
    }

    pub fn fence(&self) -> &FenceToken {
        &self.fence
    }

    pub fn lease(&self) -> &Lease {
        &self.lease
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn cancellation_reason(&self) -> Option<CancellationReason> {
        self.cancellation_reason
    }

    pub fn message(&self) -> &ProcessHostMessage {
        &self.message
    }

    pub fn to_wire_value(&self) -> Result<Value, AdapterError> {
        let mut value = self.message.to_wire_value()?;
        let object = value.as_object_mut().ok_or_else(|| {
            AdapterError::protocol("native host message did not serialize to an object")
        })?;
        object.insert(
            "runtimeIdentity".to_owned(),
            serde_json::to_value(&self.identity).map_err(|error| {
                AdapterError::protocol(format!("identity serialization failed: {error}"))
            })?,
        );
        object.insert(
            "fence".to_owned(),
            serde_json::to_value(&self.fence).map_err(|error| {
                AdapterError::protocol(format!("fence serialization failed: {error}"))
            })?,
        );
        object.insert(
            "lease".to_owned(),
            serde_json::to_value(&self.lease).map_err(|error| {
                AdapterError::protocol(format!("lease serialization failed: {error}"))
            })?,
        );
        object.insert("attempt".to_owned(), Value::from(self.attempt));
        if let Some(reason) = self.cancellation_reason {
            object.insert(
                "cancellationReason".to_owned(),
                serde_json::to_value(reason).map_err(|error| {
                    AdapterError::protocol(format!("cancellation serialization failed: {error}"))
                })?,
            );
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProcessHostOutput {
    pub stdout: String,
    pub stderr: String,
    pub result: Option<Value>,
}

impl ProcessHostOutput {
    pub fn new(
        stdout: impl Into<String>,
        stderr: impl Into<String>,
        result: Option<Value>,
    ) -> Self {
        Self {
            stdout: stdout.into(),
            stderr: stderr.into(),
            result,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessHostTerminalStatus {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessHostTerminal {
    pub status: ProcessHostTerminalStatus,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub cleanup_proven: bool,
    #[serde(default)]
    pub receipt_written: bool,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<String>,
}

impl ProcessHostTerminal {
    pub fn succeeded(exit_code: Option<i32>, signal: Option<&str>) -> Self {
        Self {
            status: ProcessHostTerminalStatus::Succeeded,
            error_code: None,
            message: None,
            cleanup_proven: true,
            receipt_written: true,
            exit_code,
            signal: signal.map(str::to_owned),
        }
    }

    pub fn succeeded_without_cleanup() -> Self {
        Self {
            cleanup_proven: false,
            receipt_written: false,
            ..Self::succeeded(Some(0), None)
        }
    }

    pub fn failed(error_code: Option<&str>, exit_code: Option<i32>, signal: Option<&str>) -> Self {
        Self {
            status: ProcessHostTerminalStatus::Failed,
            error_code: error_code.map(str::to_owned),
            message: None,
            cleanup_proven: true,
            receipt_written: true,
            exit_code,
            signal: signal.map(str::to_owned),
        }
    }

    pub fn is_durable(&self) -> bool {
        self.cleanup_proven && self.receipt_written
    }
}

impl TryFrom<Value> for ProcessHostTerminal {
    type Error = AdapterError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        serde_json::from_value(value)
            .map_err(|error| AdapterError::protocol(format!("invalid terminal event: {error}")))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeProcessOutcome {
    identity: RuntimeIdentity,
    lease: Lease,
    fence: FenceToken,
    attempt: u32,
    status: RunStatus,
    result: ResultEnvelope,
    exit_code: Option<i32>,
    signal: Option<String>,
}

impl RuntimeProcessOutcome {
    pub fn identity(&self) -> &RuntimeIdentity {
        &self.identity
    }

    pub fn fence(&self) -> &FenceToken {
        &self.fence
    }

    pub fn lease(&self) -> &Lease {
        &self.lease
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn status(&self) -> RunStatus {
        self.status
    }

    pub fn result(&self) -> &ResultEnvelope {
        &self.result
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub fn signal(&self) -> Option<&str> {
        self.signal.as_deref()
    }
}

/// A side-effect-free adapter bound to one admitted run attempt and its lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeProcessAdapter {
    identity: RuntimeIdentity,
    lease: Lease,
    fence: FenceToken,
    attempt: u32,
    output_limits: OutputLimits,
    deadline_at_millis: Option<u64>,
    request_id: String,
    launch: ProcessLaunch,
}

impl RuntimeProcessAdapter {
    pub fn new(
        machine: &RunMachine,
        launch: ProcessLaunch,
        now_millis: u64,
    ) -> Result<Self, AdapterError> {
        if !matches!(machine.status(), RunStatus::Queued | RunStatus::Running) {
            return Err(AdapterError::conflict(
                "run_not_active",
                "process host can only be bound to a queued or running run",
            ));
        }
        if machine.admission().state() != AdmissionState::Admitted {
            return Err(AdapterError::conflict(
                "run_not_admitted",
                "process host requires an admitted run",
            ));
        }
        if machine.cancellation() != CancellationState::NotRequested {
            return Err(AdapterError::cancelled(
                "cancel_requested",
                "process host cannot start a cancelled run",
            ));
        }
        let lease = machine.lease().ok_or_else(|| {
            AdapterError::stale("stale_fence", "process host requires an execution lease")
        })?;
        if !lease.valid_at(now_millis) {
            return Err(AdapterError::lease_expired());
        }

        let identity = machine.request.identity.clone();
        let request_id = identity.run_id.clone();
        let message = ProcessHostMessage::start_process(request_id.clone(), &launch);
        launch.validate_owner_token()?;
        message.validate()?;

        Ok(Self {
            identity,
            lease: lease.clone(),
            fence: lease.fence.clone(),
            attempt: machine.attempt(),
            output_limits: machine.request.output_limits.clone(),
            deadline_at_millis: machine.deadline_at_millis(),
            request_id,
            launch,
        })
    }

    pub fn identity(&self) -> &RuntimeIdentity {
        &self.identity
    }

    pub fn fence(&self) -> &FenceToken {
        &self.fence
    }

    pub fn lease(&self) -> &Lease {
        &self.lease
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn launch(&self) -> &ProcessLaunch {
        &self.launch
    }

    pub fn start(
        &self,
        machine: &RunMachine,
        now_millis: u64,
    ) -> Result<BoundProcessHostMessage, AdapterError> {
        self.assert_current(machine, &self.fence, now_millis, true)?;
        if !matches!(machine.status(), RunStatus::Queued | RunStatus::Running) {
            return Err(AdapterError::conflict(
                "run_not_active",
                "process host can only start for a queued or running run",
            ));
        }
        if machine.cancellation() != CancellationState::NotRequested {
            return Err(AdapterError::cancelled(
                "cancel_requested",
                "a cancellation request must be handled before starting the process",
            ));
        }
        BoundProcessHostMessage::new(
            self.identity.clone(),
            self.lease.clone(),
            self.fence.clone(),
            self.attempt,
            None,
            ProcessHostMessage::start_process(self.request_id.clone(), &self.launch),
        )
    }

    pub fn stop(
        &self,
        machine: &RunMachine,
        fence: &FenceToken,
        now_millis: u64,
        reason: CancellationReason,
        grace_ms: Option<u64>,
    ) -> Result<BoundProcessHostMessage, AdapterError> {
        self.assert_current(machine, fence, now_millis, false)?;
        if !matches!(machine.status(), RunStatus::Queued | RunStatus::Running) {
            return Err(AdapterError::conflict(
                "run_not_active",
                "process host stop requires a queued or running run",
            ));
        }
        match reason {
            CancellationReason::Timeout => {
                if self
                    .deadline_at_millis
                    .is_none_or(|deadline| now_millis < deadline)
                {
                    return Err(AdapterError::invalid(
                        "timeout_not_due",
                        "timeout stop was requested before the run deadline",
                    ));
                }
            }
            _ => {
                if machine.cancellation() != CancellationState::Requested
                    || machine.cancellation_reason() != Some(reason)
                {
                    return Err(AdapterError::cancelled(
                        "cancel_not_requested",
                        "stop requires the matching runtime cancellation request",
                    ));
                }
            }
        }
        BoundProcessHostMessage::new(
            self.identity.clone(),
            self.lease.clone(),
            self.fence.clone(),
            self.attempt,
            Some(reason),
            ProcessHostMessage::stop(self.request_id.clone(), grace_ms),
        )
    }

    pub fn input(
        &self,
        machine: &RunMachine,
        fence: &FenceToken,
        now_millis: u64,
        data: impl Into<String>,
    ) -> Result<BoundProcessHostMessage, AdapterError> {
        self.assert_control_allowed(machine, fence, now_millis)?;
        BoundProcessHostMessage::new(
            self.identity.clone(),
            self.lease.clone(),
            self.fence.clone(),
            self.attempt,
            None,
            ProcessHostMessage::input(self.request_id.clone(), data.into()),
        )
    }

    pub fn resize(
        &self,
        machine: &RunMachine,
        fence: &FenceToken,
        now_millis: u64,
        cols: u16,
        rows: u16,
    ) -> Result<BoundProcessHostMessage, AdapterError> {
        self.assert_control_allowed(machine, fence, now_millis)?;
        BoundProcessHostMessage::new(
            self.identity.clone(),
            self.lease.clone(),
            self.fence.clone(),
            self.attempt,
            None,
            ProcessHostMessage::resize(self.request_id.clone(), cols, rows),
        )
    }

    pub fn map_terminal(
        &self,
        machine: &RunMachine,
        now_millis: u64,
        terminal: ProcessHostTerminal,
        output: ProcessHostOutput,
    ) -> Result<RuntimeProcessOutcome, AdapterError> {
        self.assert_current(machine, &self.fence, now_millis, false)?;
        if machine.status() != RunStatus::Running {
            return Err(AdapterError::conflict(
                "run_not_running",
                "a process-host terminal event requires a running run",
            ));
        }

        let (status, failure) = self.terminal_status(machine, now_millis, &terminal);
        let result = match failure {
            Some(failure) => ResultEnvelope::failure(
                failure,
                output.stdout,
                output.stderr,
                self.output_limits.clone(),
            ),
            None => ResultEnvelope::success(
                output.stdout,
                output.stderr,
                output.result,
                self.output_limits.clone(),
            ),
        }
        .map_err(|error| AdapterError::output_limit(error.to_string()))?;

        Ok(RuntimeProcessOutcome {
            identity: self.identity.clone(),
            lease: self.lease.clone(),
            fence: self.fence.clone(),
            attempt: self.attempt,
            status,
            result,
            exit_code: terminal.exit_code,
            signal: terminal.signal,
        })
    }

    fn terminal_status(
        &self,
        machine: &RunMachine,
        now_millis: u64,
        terminal: &ProcessHostTerminal,
    ) -> (RunStatus, Option<Failure>) {
        let cancellation = machine.cancellation_reason();
        if cancellation == Some(CancellationReason::Timeout)
            || self
                .deadline_at_millis
                .is_some_and(|deadline| now_millis >= deadline)
            || terminal
                .error_code
                .as_deref()
                .is_some_and(|code| matches!(code, "timeout" | "timed_out"))
        {
            return (
                RunStatus::TimedOut,
                Some(Failure::new(
                    FailureCategory::TimedOut,
                    "timed_out",
                    "run exceeded its execution deadline",
                    true,
                )),
            );
        }

        if cancellation.is_some()
            || terminal
                .error_code
                .as_deref()
                .is_some_and(|code| matches!(code, "cancelled" | "stopped"))
        {
            return (
                RunStatus::Cancelled,
                Some(Failure::new(
                    FailureCategory::Cancelled,
                    "cancelled",
                    "run was cancelled before the process host completed",
                    false,
                )),
            );
        }

        let process_failed = terminal.status == ProcessHostTerminalStatus::Failed
            || !terminal.is_durable()
            || terminal.exit_code.is_some_and(|code| code != 0)
            || terminal.signal.is_some();
        if !process_failed {
            return (RunStatus::Succeeded, None);
        }

        let code = terminal_failure_code(terminal);
        let (category, retryable) = failure_category(code);
        let summary = terminal
            .message
            .as_deref()
            .filter(|message| !message.trim().is_empty())
            .unwrap_or("process host reported a failed terminal outcome");
        (
            RunStatus::Failed,
            Some(Failure::new(
                category,
                code,
                bounded_summary(summary),
                retryable,
            )),
        )
    }

    fn assert_control_allowed(
        &self,
        machine: &RunMachine,
        fence: &FenceToken,
        now_millis: u64,
    ) -> Result<(), AdapterError> {
        self.assert_current(machine, fence, now_millis, true)?;
        if machine.status() != RunStatus::Running {
            return Err(AdapterError::conflict(
                "run_not_running",
                "process controls require a running run",
            ));
        }
        if machine.cancellation() != CancellationState::NotRequested {
            return Err(AdapterError::cancelled(
                "cancel_requested",
                "process controls are rejected after cancellation",
            ));
        }
        Ok(())
    }

    fn assert_current(
        &self,
        machine: &RunMachine,
        fence: &FenceToken,
        now_millis: u64,
        require_live_lease: bool,
    ) -> Result<(), AdapterError> {
        if machine.request.identity != self.identity {
            return Err(AdapterError::stale(
                "stale_identity",
                "runtime identity no longer matches the process adapter",
            ));
        }
        if machine.attempt() != self.attempt {
            return Err(AdapterError::stale(
                "stale_attempt",
                "runtime attempt no longer matches the process adapter",
            ));
        }
        let lease = machine.lease().ok_or_else(|| {
            AdapterError::stale("stale_fence", "runtime no longer has an execution lease")
        })?;
        if fence != &self.fence || lease.fence != self.fence {
            return Err(AdapterError::stale(
                "stale_fence",
                "process control fence is not the current run fence",
            ));
        }
        if require_live_lease && !lease.valid_at(now_millis) {
            return Err(AdapterError::lease_expired());
        }
        Ok(())
    }
}

fn terminal_failure_code(terminal: &ProcessHostTerminal) -> &'static str {
    let code = stable_failure_code(terminal.error_code.as_deref());
    if code != "process_host_failed" {
        return code;
    }
    if !terminal.cleanup_proven {
        return "process_group_cleanup_unproven";
    }
    if !terminal.receipt_written {
        return "receipt_write_failed";
    }
    code
}

fn stable_failure_code(code: Option<&str>) -> &'static str {
    match code {
        Some(code) if is_stable_code(code) => match code {
            "cancelled" | "stopped" => "cancelled",
            "timeout" | "timed_out" => "timed_out",
            other => match other {
                "child_exit" => "child_exit",
                "output_spool_overflow" => "output_spool_overflow",
                "output_relay_failed" => "output_relay_failed",
                "control_lost" => "control_lost",
                "process_group_cleanup_unproven" => "process_group_cleanup_unproven",
                "descendant_cleanup" => "descendant_cleanup",
                "listener_owner_mismatch" => "listener_owner_mismatch",
                "cleanup_unproven" => "cleanup_unproven",
                "receipt_write_failed" => "receipt_write_failed",
                "lease_expired" => "lease_expired",
                "stale_fence" => "stale_fence",
                _ => "process_host_failed",
            },
        },
        _ => "process_host_failed",
    }
}

fn is_stable_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn failure_category(code: &str) -> (FailureCategory, bool) {
    match code {
        "output_spool_overflow" | "output_relay_failed" => (FailureCategory::OutputLimit, false),
        "lease_expired" => (FailureCategory::LeaseExpired, true),
        "stale_fence" => (FailureCategory::StaleFence, false),
        "control_lost"
        | "process_group_cleanup_unproven"
        | "descendant_cleanup"
        | "listener_owner_mismatch"
        | "cleanup_unproven"
        | "receipt_write_failed" => (FailureCategory::Internal, false),
        _ => (FailureCategory::Internal, false),
    }
}

fn bounded_summary(summary: &str) -> String {
    let mut end = summary.len().min(4 * 1024);
    while end > 0 && !summary.is_char_boundary(end) {
        end -= 1;
    }
    summary[..end].to_owned()
}

pub type HostMessage = ProcessHostMessage;
pub type HostTerminal = ProcessHostTerminal;
pub type RunProcessAdapter = RuntimeProcessAdapter;
pub type RunProcessOutcome = RuntimeProcessOutcome;
