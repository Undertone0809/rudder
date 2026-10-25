//! Run-scoped fallback state shared by the CLI and typed MCP transports.
//!
//! The JSON keys and hashed filenames intentionally match the legacy CLI
//! implementation so a failure observed by one surface remains visible to the
//! other while the migration is in progress.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const DEFAULT_BACKOFF_MS: u64 = 60_000;
const PROBE_TIMEOUT_MS: u64 = 10_000;
const PROBE_POLL_MS: u64 = 10;
const LOCK_RETRY_MS: u64 = 5;
const LOCK_TIMEOUT_MS: u64 = 250;
const HEALTHY_EXPIRY_MS: u64 = 9_007_199_254_740_991;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static RESERVATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransportSurface {
    Cli,
    Mcp,
}

impl TransportSurface {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Mcp => "mcp",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "cli" => Some(Self::Cli),
            "mcp" => Some(Self::Mcp),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    RequestInFlight,
    FallbackAvailable,
    FallbackInFlight,
    ProbeInFlight,
    Blocked,
    Healthy,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::RequestInFlight => "request_in_flight",
            Self::FallbackAvailable => "fallback_available",
            Self::FallbackInFlight => "fallback_in_flight",
            Self::ProbeInFlight => "probe_in_flight",
            Self::Blocked => "blocked",
            Self::Healthy => "healthy",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "request_in_flight" => Some(Self::RequestInFlight),
            "fallback_available" => Some(Self::FallbackAvailable),
            "fallback_in_flight" => Some(Self::FallbackInFlight),
            "probe_in_flight" => Some(Self::ProbeInFlight),
            "blocked" => Some(Self::Blocked),
            "healthy" => Some(Self::Healthy),
            _ => None,
        }
    }

    fn requires_failure(self) -> bool {
        matches!(
            self,
            Self::FallbackAvailable | Self::FallbackInFlight | Self::Blocked
        )
    }
}

#[derive(Clone, Debug)]
struct Scope {
    operation: String,
    scope_key: String,
    issue_id: Option<String>,
    fallback_command: Option<String>,
    fallback_body_file: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct Fingerprint {
    fingerprint: String,
    status: u16,
    code: String,
    normalized_message: String,
}

#[derive(Clone, Debug)]
struct State {
    operation: String,
    scope_key: String,
    issue_id: Option<String>,
    fallback_command: Option<String>,
    fallback_body_file: Option<PathBuf>,
    generation: u64,
    active_reservations: Vec<String>,
    phase: Phase,
    initial_surface: TransportSurface,
    probe_backoff: bool,
    fallback_surface: Option<TransportSurface>,
    fallback_matched_fingerprint: Option<bool>,
    failure: Option<Fingerprint>,
    observed_at: f64,
    expires_at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Attempt {
    Initial,
    Fallback,
}

#[derive(Clone, Debug)]
pub(crate) struct Reservation {
    file_path: PathBuf,
    scope: Scope,
    surface: TransportSurface,
    attempt: Attempt,
    reservation_id: String,
    generation: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct IssueTransportBudget {
    run_id: Option<String>,
    surface: TransportSurface,
    state_dir: PathBuf,
    backoff_ms: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct BudgetFailure {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct FailureOutcome {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

#[derive(Clone, Debug)]
pub(crate) enum ReserveOutcome {
    Untracked,
    Allowed(Reservation),
    Blocked(BudgetFailure),
}

#[derive(Clone, Debug)]
struct FallbackAction {
    surface: TransportSurface,
    command: Option<String>,
    tool: Option<String>,
}

impl IssueTransportBudget {
    pub(crate) fn from_environment(
        environment: &BTreeMap<String, String>,
        surface: TransportSurface,
    ) -> Self {
        let run_id = environment
            .get("RUDDER_RUN_ID")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let state_dir = environment
            .get("RUDDER_RUNTIME_TMPDIR")
            .map(|value| PathBuf::from(value.trim()))
            .unwrap_or_else(|| std::env::temp_dir().join("rudder-issue-transport"));
        Self {
            run_id,
            surface,
            state_dir,
            backoff_ms: DEFAULT_BACKOFF_MS,
        }
    }

    #[cfg(test)]
    fn with_options(
        run_id: Option<&str>,
        surface: TransportSurface,
        state_dir: PathBuf,
        backoff_ms: u64,
    ) -> Self {
        Self {
            run_id: run_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            surface,
            state_dir,
            backoff_ms,
        }
    }

    pub(crate) fn reserve(
        &self,
        method: Option<&str>,
        request_path: &str,
        request_body: Option<&Value>,
    ) -> Result<ReserveOutcome, BudgetFailure> {
        let Some(run_id) = self.run_id.as_deref() else {
            return Ok(ReserveOutcome::Untracked);
        };
        let Some(scope) = request_scope(method, request_path) else {
            return Ok(ReserveOutcome::Untracked);
        };
        let file_path = self.state_file_path(run_id, &scope);

        loop {
            let result = self.with_lock(&file_path, || {
                let now = now_ms();
                let mut state = read_state(&file_path)?;
                if let Some(current) = state.as_mut()
                    && current.phase != Phase::Healthy
                    && current.expires_at <= now
                {
                    if current.phase == Phase::ProbeInFlight && !current.probe_backoff {
                        current.probe_backoff = true;
                        current.observed_at = now;
                        current.expires_at = now + self.backoff_ms as f64;
                        write_state(&file_path, current)?;
                    } else {
                        state = Some(retire_expired_state(&file_path, current.clone(), now)?);
                    }
                }

                if state
                    .as_ref()
                    .is_none_or(|current| current.phase == Phase::Healthy)
                {
                    let generation = state.as_ref().map_or(1, |current| current.generation + 1);
                    let reservation_id = next_reservation_id();
                    let prepared = prepare_initial_scope(
                        &scope,
                        self.surface,
                        &file_path,
                        &reservation_id,
                        request_body,
                    )?;
                    let phase = if should_gate_concurrent(&prepared) {
                        Phase::ProbeInFlight
                    } else {
                        Phase::RequestInFlight
                    };
                    let current = State {
                        operation: prepared.operation.clone(),
                        scope_key: prepared.scope_key.clone(),
                        issue_id: prepared.issue_id.clone(),
                        fallback_command: prepared.fallback_command.clone(),
                        fallback_body_file: prepared.fallback_body_file.clone(),
                        generation,
                        active_reservations: vec![reservation_id.clone()],
                        phase,
                        initial_surface: self.surface,
                        probe_backoff: false,
                        fallback_surface: None,
                        fallback_matched_fingerprint: None,
                        failure: None,
                        observed_at: now,
                        expires_at: now + PROBE_TIMEOUT_MS as f64,
                    };
                    if let Err(error) = write_state(&file_path, &current) {
                        cleanup_owned_comment_body_file(
                            &file_path,
                            prepared.fallback_body_file.as_deref(),
                        );
                        return Err(error);
                    }
                    return Ok(InternalReserve::Allowed(Reservation {
                        file_path: file_path.clone(),
                        scope: prepared,
                        surface: self.surface,
                        attempt: Attempt::Initial,
                        reservation_id,
                        generation,
                    }));
                }

                let current = state.expect("state is present after healthy-state branch");
                if current.phase == Phase::RequestInFlight {
                    let reservation_id = next_reservation_id();
                    let prepared = prepare_initial_scope(
                        &scope,
                        self.surface,
                        &file_path,
                        &reservation_id,
                        request_body,
                    )?;
                    let mut next = current.clone();
                    next.active_reservations.push(reservation_id.clone());
                    next.observed_at = now;
                    next.expires_at = now + PROBE_TIMEOUT_MS as f64;
                    if let Err(error) = write_state(&file_path, &next) {
                        cleanup_owned_comment_body_file(
                            &file_path,
                            prepared.fallback_body_file.as_deref(),
                        );
                        return Err(error);
                    }
                    return Ok(InternalReserve::Allowed(Reservation {
                        file_path: file_path.clone(),
                        scope: prepared,
                        surface: self.surface,
                        attempt: Attempt::Initial,
                        reservation_id,
                        generation: current.generation,
                    }));
                }

                if current.phase == Phase::ProbeInFlight {
                    return Ok(InternalReserve::WaitForProbe(current.expires_at));
                }

                if current.phase == Phase::FallbackAvailable
                    && current.initial_surface != self.surface
                {
                    let reservation_id = next_reservation_id();
                    let mut next = current.clone();
                    next.active_reservations.push(reservation_id.clone());
                    next.phase = Phase::FallbackInFlight;
                    next.fallback_surface = Some(self.surface);
                    next.observed_at = now;
                    write_state(&file_path, &next)?;
                    let mut fallback_scope = scope.clone();
                    if fallback_scope.fallback_command.is_none() {
                        fallback_scope.fallback_command = current.fallback_command.clone();
                    }
                    if fallback_scope.fallback_body_file.is_none() {
                        fallback_scope.fallback_body_file = current.fallback_body_file.clone();
                    }
                    return Ok(InternalReserve::Allowed(Reservation {
                        file_path: file_path.clone(),
                        scope: fallback_scope,
                        surface: self.surface,
                        attempt: Attempt::Fallback,
                        reservation_id,
                        generation: current.generation,
                    }));
                }

                Ok(InternalReserve::Blocked(issue_transport_unavailable(
                    &current, now, &scope,
                )))
            });

            match result {
                Ok(InternalReserve::Allowed(reservation)) => {
                    return Ok(ReserveOutcome::Allowed(reservation));
                }
                Ok(InternalReserve::Blocked(error)) => {
                    return Ok(ReserveOutcome::Blocked(error));
                }
                Ok(InternalReserve::WaitForProbe(expires_at)) => {
                    if let Err(error) = self.wait_for_probe(&file_path, expires_at) {
                        return Err(storage_unavailable(&scope, self.surface, error));
                    }
                }
                Err(error) => return Err(storage_unavailable(&scope, self.surface, error)),
            }
        }
    }

    pub(crate) fn succeed(&self, reservation: Option<&Reservation>) -> Result<(), BudgetFailure> {
        let Some(reservation) = reservation else {
            return Ok(());
        };
        let result = self.with_lock(&reservation.file_path, || {
            let Some(state) = read_state(&reservation.file_path)? else {
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    reservation.scope.fallback_body_file.as_deref(),
                );
                return Err(invalid_data("Missing Issue transport budget state"));
            };
            if state.generation != reservation.generation
                || !state
                    .active_reservations
                    .contains(&reservation.reservation_id)
            {
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    reservation.scope.fallback_body_file.as_deref(),
                );
                return Ok(());
            }

            let active =
                without_reservation(&state.active_reservations, &reservation.reservation_id);
            let recovered_on_alternate_surface = reservation.attempt == Attempt::Initial
                && state.initial_surface != reservation.surface
                && matches!(
                    state.phase,
                    Phase::FallbackAvailable | Phase::FallbackInFlight | Phase::Blocked
                );
            if reservation.attempt == Attempt::Fallback || recovered_on_alternate_surface {
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    state.fallback_body_file.as_deref(),
                );
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    reservation.scope.fallback_body_file.as_deref(),
                );
                write_state(
                    &reservation.file_path,
                    &healthy_state(&state, now_ms(), state.generation + 1),
                )?;
                return Ok(());
            }

            cleanup_owned_comment_body_file(
                &reservation.file_path,
                reservation.scope.fallback_body_file.as_deref(),
            );
            if active.is_empty()
                && matches!(state.phase, Phase::RequestInFlight | Phase::ProbeInFlight)
            {
                write_state(
                    &reservation.file_path,
                    &healthy_state(&state, now_ms(), state.generation + 1),
                )?;
                return Ok(());
            }
            let mut next = state;
            next.active_reservations = active;
            next.observed_at = now_ms();
            write_state(&reservation.file_path, &next)
        });
        result.map_err(|error| storage_unavailable(&reservation.scope, self.surface, error))
    }

    pub(crate) fn fail(
        &self,
        reservation: Option<&Reservation>,
        status: u16,
        code: &str,
        message: &str,
        upstream_details: Option<&Value>,
    ) -> Result<FailureOutcome, BudgetFailure> {
        let mut outcome = FailureOutcome {
            status,
            code: code.to_owned(),
            message: message.to_owned(),
            details: upstream_details.cloned(),
        };
        let Some(reservation) = reservation else {
            return Ok(outcome);
        };
        if !(500..=599).contains(&status) {
            self.succeed(Some(reservation))?;
            return Ok(outcome);
        }

        let failure = build_fingerprint(&reservation.scope, status, code, message);
        let result = self.with_lock(&reservation.file_path, || {
            let Some(current) = read_state(&reservation.file_path)? else {
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    reservation.scope.fallback_body_file.as_deref(),
                );
                return Err(invalid_data("Missing Issue transport budget state"));
            };
            if current.generation != reservation.generation
                || !current
                    .active_reservations
                    .contains(&reservation.reservation_id)
            {
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    reservation.scope.fallback_body_file.as_deref(),
                );
                return Ok(None);
            }

            let active =
                without_reservation(&current.active_reservations, &reservation.reservation_id);
            let matches_current = current
                .failure
                .as_ref()
                .is_some_and(|existing| fingerprints_match(&reservation.scope, existing, &failure));
            let now = now_ms();
            let next = if reservation.attempt == Attempt::Fallback {
                let mut next = current.clone();
                next.phase = Phase::Blocked;
                next.fallback_surface = Some(reservation.surface);
                next.fallback_matched_fingerprint =
                    current.failure.as_ref().map(|_| matches_current);
                next.failure = Some(failure.clone());
                next.active_reservations = active;
                next.observed_at = now;
                next.expires_at = now + self.backoff_ms as f64;
                next
            } else if current.phase == Phase::Healthy {
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    reservation.scope.fallback_body_file.as_deref(),
                );
                return Ok(None);
            } else if current.failure.is_none()
                || matches!(current.phase, Phase::RequestInFlight | Phase::ProbeInFlight)
            {
                let mut next = state_from_scope(
                    &reservation.scope,
                    current.generation,
                    active,
                    Phase::FallbackAvailable,
                    current.initial_surface,
                    now,
                    now + self.backoff_ms as f64,
                );
                next.failure = Some(failure.clone());
                next
            } else if reservation.attempt == Attempt::Initial && matches_current {
                let mut next = current.clone();
                next.active_reservations = active;
                next.observed_at = now;
                next
            } else if matches_current {
                let mut next = current.clone();
                next.phase = Phase::Blocked;
                next.active_reservations = active;
                next.fallback_matched_fingerprint = Some(true);
                next.observed_at = now;
                next.expires_at = now + self.backoff_ms as f64;
                next
            } else {
                let mut next = current.clone();
                next.active_reservations = active;
                next.observed_at = now;
                next
            };

            if next.fallback_body_file != reservation.scope.fallback_body_file {
                cleanup_owned_comment_body_file(
                    &reservation.file_path,
                    reservation.scope.fallback_body_file.as_deref(),
                );
            }
            write_state(&reservation.file_path, &next)?;
            Ok(Some(next))
        });
        let state =
            result.map_err(|error| storage_unavailable(&reservation.scope, self.surface, error))?;
        if let Some(state) = state {
            let diagnostic = transport_diagnostic(&state, now_ms(), &reservation.scope);
            outcome.details = Some(attach_diagnostic(upstream_details, diagnostic));
            if let Some(fallback) = fallback_action(&state, &reservation.scope) {
                outcome.message = format!(
                    "{}; use the equivalent {} fallback once: {}",
                    outcome.message,
                    fallback_surface_label(fallback.surface),
                    fallback_target(&fallback)
                );
            }
            if state.phase == Phase::Blocked {
                outcome.code = "issue_transport_unavailable".to_owned();
                outcome.message = "Issue transport unavailable".to_owned();
            }
        }
        Ok(outcome)
    }

    fn state_file_path(&self, run_id: &str, scope: &Scope) -> PathBuf {
        let key_scope = if is_legacy_issue_scope(scope) {
            scope.issue_id.as_deref().unwrap_or(&scope.scope_key)
        } else {
            &scope.scope_key
        };
        let key = format!(
            "{run_id}\n{}\n{key_scope}",
            transport_budget_operation(scope)
        );
        self.state_dir
            .join("issue-transport-budget")
            .join(format!("{}.json", sha256_hex(key.as_bytes())))
    }

    fn wait_for_probe(&self, file_path: &Path, expires_at: f64) -> io::Result<()> {
        let wait_deadline = now_ms() + (expires_at - now_ms()).max(0.0);
        loop {
            let state = read_state(file_path)?;
            let now = now_ms();
            if state
                .as_ref()
                .is_none_or(|state| state.phase != Phase::ProbeInFlight || state.expires_at <= now)
            {
                return Ok(());
            }
            if now >= wait_deadline {
                self.with_lock(file_path, || {
                    if let Some(mut current) = read_state(file_path)?
                        && current.phase == Phase::ProbeInFlight
                        && !current.probe_backoff
                        && (current.expires_at <= now_ms() || current.expires_at == expires_at)
                    {
                        current.probe_backoff = true;
                        current.observed_at = now_ms();
                        current.expires_at = current.observed_at + self.backoff_ms as f64;
                        write_state(file_path, &current)?;
                    }
                    Ok(())
                })?;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(PROBE_POLL_MS));
        }
    }

    fn with_lock<T>(
        &self,
        file_path: &Path,
        action: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        let parent = file_path
            .parent()
            .ok_or_else(|| invalid_data("Invalid Issue transport budget path"))?;
        create_private_dir(parent)?;
        let lock_path = append_suffix(file_path, ".lock");
        let deadline = now_ms() + LOCK_TIMEOUT_MS as f64;
        let lock = loop {
            match private_open_options()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(lock) => break lock,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if now_ms() >= deadline {
                        return Err(error);
                    }
                    thread::sleep(Duration::from_millis(LOCK_RETRY_MS));
                }
                Err(error) => return Err(error),
            }
        };
        let result = action();
        drop(lock);
        let remove_result = fs::remove_file(&lock_path);
        match (result, remove_result) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) if error.kind() != io::ErrorKind::NotFound => Err(error),
            (Ok(value), _) => Ok(value),
        }
    }
}

enum InternalReserve {
    Allowed(Reservation),
    Blocked(BudgetFailure),
    WaitForProbe(f64),
}

fn request_scope(method: Option<&str>, request_path: &str) -> Option<Scope> {
    let method = method.unwrap_or("GET").to_ascii_uppercase();
    let normalized_path = if request_path.starts_with('/') {
        request_path.to_owned()
    } else {
        format!("/{request_path}")
    };
    let url = Url::parse(&format!("http://rudder.local{normalized_path}")).ok()?;
    let segments = url.path().split('/').collect::<Vec<_>>();

    if segments.len() >= 4 && segments[1] == "api" && segments[2] == "issues" {
        let issue_id = decode_scope_value(segments[3])?;
        if issue_id.is_empty() {
            return None;
        }
        let (operation, comment_id) = match segments.as_slice() {
            ["", "api", "issues", _] if method == "GET" => ("issue.get", None),
            ["", "api", "issues", _, "heartbeat-context"] if method == "GET" => {
                ("issue.context", None)
            }
            ["", "api", "issues", _, "comments"] if method == "GET" => {
                ("issue.comments.list", None)
            }
            ["", "api", "issues", _, "comments", comment] if method == "GET" => {
                ("issue.comments.get", Some(decode_scope_value(comment)?))
            }
            ["", "api", "issues", _, "comments"] if method == "POST" => ("issue.comment", None),
            _ => return None,
        };
        let mut scope = Scope {
            operation: operation.to_owned(),
            scope_key: format!("issue:{issue_id}"),
            issue_id: Some(issue_id),
            fallback_command: None,
            fallback_body_file: None,
        };
        if operation != "issue.comment" {
            scope.fallback_command = Some(build_cli_fallback_command(
                operation,
                scope.issue_id.as_deref(),
                comment_id.as_deref(),
                &url,
                None,
            ));
        }
        return Some(scope);
    }

    if segments.len() == 5
        && segments[1] == "api"
        && segments[2] == "orgs"
        && segments[4] == "issues"
        && method == "GET"
    {
        let org_id = decode_scope_value(segments[3])?;
        if org_id.is_empty() {
            return None;
        }
        let project_id = query_value(&url, "projectId").and_then(normalize_scope_value);
        let operation = if query_value(&url, "q")
            .and_then(normalize_scope_value)
            .is_some()
        {
            "issue.search"
        } else {
            "issue.list"
        };
        return Some(Scope {
            operation: operation.to_owned(),
            scope_key: format!(
                "org:{org_id}|project:{}",
                project_id.as_deref().unwrap_or("*")
            ),
            issue_id: None,
            fallback_command: Some(build_cli_fallback_command(
                operation,
                None,
                None,
                &url,
                Some(&org_id),
            )),
            fallback_body_file: None,
        });
    }

    if segments.len() == 6
        && segments[1] == "api"
        && segments[2] == "run-intelligence"
        && segments[3] == "orgs"
        && segments[5] == "runs"
        && method == "GET"
    {
        let org_id = decode_scope_value(segments[4])?;
        if org_id.is_empty() {
            return None;
        }
        let issue_id = query_value(&url, "issueId").and_then(normalize_scope_value);
        let scope_key = if let Some(issue_id) = issue_id.as_deref() {
            format!("org:{org_id}|issue:{issue_id}")
        } else {
            format!("org:{org_id}")
        };
        return Some(Scope {
            operation: "runs.list".to_owned(),
            scope_key,
            issue_id,
            fallback_command: Some(build_runs_fallback_command(&url, &org_id)),
            fallback_body_file: None,
        });
    }
    None
}

fn query_value(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn decode_scope_value(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            decoded.push((hex_value(high)? << 4) | hex_value(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded)
        .ok()
        .map(|value| js_trim(&value).to_owned())
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn normalize_scope_value(value: String) -> Option<String> {
    let value = js_trim(&value);
    (!value.is_empty()).then(|| value.to_owned())
}

fn build_fingerprint(scope: &Scope, status: u16, code: &str, message: &str) -> Fingerprint {
    let normalized_message = normalize_error_message(message);
    let code = {
        let code = js_trim(code);
        if code.is_empty() {
            "api_request_error".to_owned()
        } else {
            code.to_owned()
        }
    };
    let value = format!(
        "{}\n{}\n{}\n{}\n{}",
        transport_budget_operation(scope),
        scope.scope_key,
        status,
        code,
        normalized_message
    );
    Fingerprint {
        fingerprint: sha256_hex(value.as_bytes()),
        status,
        code,
        normalized_message,
    }
}

fn normalize_error_message(message: &str) -> String {
    let trimmed = js_trim(message);
    let mut normalized = String::with_capacity(trimmed.len());
    let mut previous_was_space = false;
    for character in trimmed.chars() {
        if is_js_whitespace(character) {
            if !previous_was_space {
                normalized.push(' ');
            }
            previous_was_space = true;
        } else {
            normalized.extend(character.to_lowercase());
            previous_was_space = false;
        }
    }
    let prefix = normalized.encode_utf16().take(256).collect::<Vec<_>>();
    String::from_utf16_lossy(&prefix)
}

fn fingerprints_match(scope: &Scope, current: &Fingerprint, next: &Fingerprint) -> bool {
    if current.fingerprint == next.fingerprint {
        return true;
    }
    if !is_legacy_issue_scope(scope)
        || current.status != next.status
        || current.code != next.code
        || current.normalized_message != next.normalized_message
    {
        return false;
    }
    let legacy_value = format!(
        "{}\n{}\n{}\n{}\n{}",
        scope.operation,
        scope.issue_id.as_deref().unwrap_or_default(),
        next.status,
        next.code,
        next.normalized_message
    );
    current.fingerprint == sha256_hex(legacy_value.as_bytes())
}

fn issue_transport_unavailable(state: &State, now: f64, scope: &Scope) -> BudgetFailure {
    let base = if matches!(state.phase, Phase::FallbackInFlight | Phase::ProbeInFlight) {
        "Issue transport probe already in flight"
    } else {
        "Issue transport unavailable"
    };
    let message = fallback_action(state, scope).map_or_else(
        || base.to_owned(),
        |fallback| {
            format!(
                "{base}; use the equivalent {} fallback once: {}",
                fallback_surface_label(fallback.surface),
                fallback_target(&fallback)
            )
        },
    );
    BudgetFailure {
        status: 503,
        code: "issue_transport_unavailable".to_owned(),
        message,
        details: json!({"issueTransport": transport_diagnostic(state, now, scope)}),
    }
}

fn attach_diagnostic(upstream: Option<&Value>, diagnostic: Value) -> Value {
    let mut details = match upstream {
        Some(Value::Object(object)) => object.clone(),
        None => Map::new(),
        Some(value) => Map::from_iter([("upstreamDetails".to_owned(), value.clone())]),
    };
    details.insert("issueTransport".to_owned(), diagnostic);
    Value::Object(details)
}

fn transport_diagnostic(state: &State, now: f64, scope: &Scope) -> Value {
    json!({
        "state": state.phase.as_str(),
        "fingerprint": state.failure.as_ref().map(|failure| failure.fingerprint.as_str()),
        "operation": scope.operation,
        "scopeKey": state.scope_key,
        "issueId": state.issue_id,
        "upstreamStatus": state.failure.as_ref().map(|failure| failure.status),
        "upstreamCode": state.failure.as_ref().map(|failure| failure.code.as_str()),
        "normalizedServerMessage": state.failure.as_ref().map(|failure| failure.normalized_message.as_str()),
        "initialSurface": state.initial_surface.as_str(),
        "fallbackSurface": state.fallback_surface.map(TransportSurface::as_str),
        "fallbackMatchedFingerprint": state.fallback_matched_fingerprint,
        "fallbackBudgetRemaining": if state.phase == Phase::FallbackAvailable { 1 } else { 0 },
        "fallbackAction": fallback_action(state, scope).map(fallback_action_json),
        "retryAfterMs": (state.expires_at - now).max(0.0),
        "checkpoint": "Issue transport unavailable"
    })
}

fn fallback_action(state: &State, scope: &Scope) -> Option<FallbackAction> {
    if state.phase != Phase::FallbackAvailable {
        return None;
    }
    if state.initial_surface == TransportSurface::Mcp {
        if let Some(command) = scope
            .fallback_command
            .as_ref()
            .or(state.fallback_command.as_ref())
        {
            return Some(FallbackAction {
                surface: TransportSurface::Cli,
                command: Some(command.clone()),
                tool: None,
            });
        }
        if state.operation == "issue.comment" || !is_legacy_issue_state(state) {
            return None;
        }
        return Some(FallbackAction {
            surface: TransportSurface::Cli,
            command: Some(build_cli_fallback_command(
                &state.operation,
                state.issue_id.as_deref(),
                None,
                &Url::parse("http://rudder.local/").expect("valid fixed URL"),
                None,
            )),
            tool: None,
        });
    }
    Some(FallbackAction {
        surface: TransportSurface::Mcp,
        command: None,
        tool: Some(format!("rudder_{}", scope.operation.replace('.', "_"))),
    })
}

fn fallback_action_json(fallback: FallbackAction) -> Value {
    let mut value = Map::new();
    value.insert("surface".to_owned(), json!(fallback.surface.as_str()));
    if let Some(command) = fallback.command {
        value.insert("command".to_owned(), json!(command));
    }
    if let Some(tool) = fallback.tool {
        value.insert("tool".to_owned(), json!(tool));
    }
    Value::Object(value)
}

fn fallback_surface_label(surface: TransportSurface) -> &'static str {
    match surface {
        TransportSurface::Cli => "Rudder CLI",
        TransportSurface::Mcp => "Rudder MCP",
    }
}

fn fallback_target(fallback: &FallbackAction) -> &str {
    fallback
        .command
        .as_deref()
        .or(fallback.tool.as_deref())
        .unwrap_or("the alternate Rudder transport")
}

fn build_cli_fallback_command(
    operation: &str,
    issue_id: Option<&str>,
    comment_id: Option<&str>,
    url: &Url,
    org_id: Option<&str>,
) -> String {
    let issue = shell_quote(issue_id.unwrap_or("<issue-id>"));
    match operation {
        "issue.get" => format!("rudder issue get {issue} --json"),
        "issue.context" => {
            let mut command = format!("rudder issue context {issue}");
            append_cli_option(
                &mut command,
                "--wake-comment-id",
                query_value(url, "wakeCommentId").as_deref(),
            );
            format!("{command} --json")
        }
        "issue.comments.list" => {
            let mut command = format!("rudder issue comments list {issue}");
            append_cli_option(
                &mut command,
                "--after",
                query_value(url, "after").as_deref(),
            );
            append_cli_option(
                &mut command,
                "--order",
                query_value(url, "order").as_deref(),
            );
            format!("{command} --json")
        }
        "issue.comments.get" => format!(
            "rudder issue comments get {issue} {} --json",
            shell_quote(comment_id.unwrap_or("<comment-id>"))
        ),
        "issue.comment" => String::new(),
        "issue.list" | "issue.search" => {
            let Some(org_id) = org_id else {
                return String::new();
            };
            let mut command = if operation == "issue.search" {
                let query = query_value(url, "q")
                    .and_then(normalize_scope_value)
                    .unwrap_or_default();
                format!("rudder issue search {}", shell_quote(&query))
            } else {
                "rudder issue list".to_owned()
            };
            append_cli_option(&mut command, "--org-id", Some(org_id));
            append_cli_option(
                &mut command,
                "--status",
                query_value(url, "status").as_deref(),
            );
            append_cli_option(
                &mut command,
                "--assignee-agent-id",
                query_value(url, "assigneeAgentId").as_deref(),
            );
            append_cli_option(
                &mut command,
                "--project-id",
                query_value(url, "projectId").as_deref(),
            );
            format!("{command} --json")
        }
        _ => format!("rudder issue {} {issue} --json", shell_quote(operation)),
    }
}

fn build_runs_fallback_command(url: &Url, org_id: &str) -> String {
    let mut command = "rudder runs list".to_owned();
    append_cli_option(&mut command, "--org-id", Some(org_id));
    if query_value(url, "projection").as_deref() == Some("full") {
        command.push_str(" --full");
    }
    for (name, option) in [
        ("updatedAfter", "--updated-after"),
        ("runIdPrefix", "--run-id-prefix"),
        ("agentId", "--agent-id"),
        ("status", "--status"),
        ("runtime", "--runtime"),
        ("issueId", "--issue-id"),
        ("usedSkill", "--used-skill"),
        ("loadedSkill", "--loaded-skill"),
        ("createdBefore", "--created-before"),
        ("cursor", "--cursor"),
        ("limit", "--limit"),
    ] {
        append_cli_option(&mut command, option, query_value(url, name).as_deref());
    }
    format!("{command} --json")
}

fn append_cli_option(command: &mut String, option: &str, value: Option<&str>) {
    let Some(value) = value.filter(|value| !js_trim(value).is_empty()) else {
        return;
    };
    command.push(' ');
    command.push_str(option);
    command.push(' ');
    command.push_str(&shell_quote(value));
}

fn shell_quote(value: &str) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"_./:-".contains(&byte))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn read_state(path: &Path) -> io::Result<Option<State>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| invalid_data("Invalid Issue transport budget state"))?;
    normalize_state(&value)
        .map(Some)
        .ok_or_else(|| invalid_data("Invalid Issue transport budget state"))
}

fn normalize_state(value: &Value) -> Option<State> {
    let object = value.as_object()?;
    let operation = object.get("operation")?.as_str().map(js_trim)?.to_owned();
    if operation.is_empty() {
        return None;
    }
    let issue_id = object
        .get("issueId")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let scope_key = object
        .get("scopeKey")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| issue_id.as_ref().map(|id| format!("issue:{id}")))?;
    let phase = Phase::parse(object.get("phase")?.as_str()?)?;
    let initial_surface = TransportSurface::parse(object.get("initialSurface")?.as_str()?)?;
    let observed_at = object.get("observedAt")?.as_f64()?;
    let expires_at = object.get("expiresAt")?.as_f64()?;
    let generation = match object.get("generation") {
        None => 0,
        Some(value) => value.as_u64()?,
    };
    let active_reservations = match object.get("activeReservations") {
        None => Vec::new(),
        Some(value) => value
            .as_array()?
            .iter()
            .map(|item| {
                let item = item.as_str()?;
                (!item.is_empty()).then(|| item.to_owned())
            })
            .collect::<Option<Vec<_>>>()?,
    };
    let probe_backoff = match object.get("probeBackoff") {
        None => false,
        Some(value) => value.as_bool()?,
    };
    let mut fallback_command = optional_nonempty_string(object, "fallbackCommand")?;
    let fallback_body_file =
        optional_nonempty_string(object, "fallbackBodyFile")?.map(PathBuf::from);
    if operation == "issue.comment" && fallback_body_file.is_none() {
        fallback_command = None;
    }
    let fallback_surface = object
        .get("fallbackSurface")
        .and_then(Value::as_str)
        .and_then(TransportSurface::parse);
    let fallback_matched_fingerprint = object
        .get("fallbackMatchedFingerprint")
        .and_then(Value::as_bool);
    let failure = match object.get("failure") {
        None => None,
        Some(value) => Some(normalize_fingerprint(value)?),
    };
    if phase.requires_failure() && failure.is_none() {
        return None;
    }
    Some(State {
        operation,
        scope_key,
        issue_id,
        fallback_command,
        fallback_body_file,
        generation,
        active_reservations,
        phase,
        initial_surface,
        probe_backoff,
        fallback_surface,
        fallback_matched_fingerprint,
        failure,
        observed_at,
        expires_at,
    })
}

fn optional_nonempty_string(object: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match object.get(key) {
        None => Some(None),
        Some(Value::String(value)) if !value.is_empty() => Some(Some(value.clone())),
        Some(_) => None,
    }
}

fn normalize_fingerprint(value: &Value) -> Option<Fingerprint> {
    let object = value.as_object()?;
    Some(Fingerprint {
        fingerprint: object.get("fingerprint")?.as_str()?.to_owned(),
        status: u16::try_from(object.get("status")?.as_u64()?).ok()?,
        code: object.get("code")?.as_str()?.to_owned(),
        normalized_message: object.get("normalizedMessage")?.as_str()?.to_owned(),
    })
}

fn state_to_value(state: &State) -> Value {
    let mut value = Map::new();
    value.insert("operation".to_owned(), json!(state.operation));
    value.insert("scopeKey".to_owned(), json!(state.scope_key));
    if let Some(issue_id) = &state.issue_id {
        value.insert("issueId".to_owned(), json!(issue_id));
    }
    if let Some(command) = &state.fallback_command {
        value.insert("fallbackCommand".to_owned(), json!(command));
    }
    if let Some(body_file) = &state.fallback_body_file {
        value.insert(
            "fallbackBodyFile".to_owned(),
            json!(body_file.to_string_lossy()),
        );
    }
    value.insert("generation".to_owned(), json!(state.generation));
    value.insert(
        "activeReservations".to_owned(),
        json!(state.active_reservations),
    );
    value.insert("phase".to_owned(), json!(state.phase.as_str()));
    value.insert(
        "initialSurface".to_owned(),
        json!(state.initial_surface.as_str()),
    );
    value.insert("probeBackoff".to_owned(), json!(state.probe_backoff));
    if let Some(surface) = state.fallback_surface {
        value.insert("fallbackSurface".to_owned(), json!(surface.as_str()));
    }
    if let Some(matched) = state.fallback_matched_fingerprint {
        value.insert("fallbackMatchedFingerprint".to_owned(), json!(matched));
    }
    if let Some(failure) = &state.failure {
        value.insert(
            "failure".to_owned(),
            json!({
                "fingerprint": failure.fingerprint,
                "status": failure.status,
                "code": failure.code,
                "normalizedMessage": failure.normalized_message,
            }),
        );
    }
    value.insert("observedAt".to_owned(), json!(state.observed_at));
    value.insert("expiresAt".to_owned(), json!(state.expires_at));
    Value::Object(value)
}

fn write_state(file_path: &Path, state: &State) -> io::Result<()> {
    let parent = file_path
        .parent()
        .ok_or_else(|| invalid_data("Invalid Issue transport budget path"))?;
    create_private_dir(parent)?;
    let mut temporary_os = file_path.as_os_str().to_os_string();
    temporary_os.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let temporary = PathBuf::from(temporary_os);
    let bytes = serde_json::to_vec(&state_to_value(state))
        .map_err(|_| invalid_data("Could not serialize Issue transport budget state"))?;
    let write_result = (|| {
        let mut file = private_open_options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, file_path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn prepare_initial_scope(
    scope: &Scope,
    surface: TransportSurface,
    state_file_path: &Path,
    reservation_id: &str,
    request_body: Option<&Value>,
) -> io::Result<Scope> {
    if surface != TransportSurface::Mcp
        || scope.operation != "issue.comment"
        || !is_legacy_issue_scope(scope)
    {
        return Ok(scope.clone());
    }
    let Some(payload) = issue_comment_payload(request_body) else {
        return Ok(scope.clone());
    };
    let mut body_os = state_file_path.as_os_str().to_os_string();
    body_os.push(format!(".{reservation_id}.comment.md"));
    let body_file = PathBuf::from(body_os);
    let mut file = private_open_options()
        .write(true)
        .create_new(true)
        .open(&body_file)?;
    file.write_all(payload.body.as_bytes())?;
    let mut result = scope.clone();
    result.fallback_body_file = Some(body_file.clone());
    result.fallback_command = Some(build_comment_fallback_command(
        scope.issue_id.as_deref().unwrap_or_default(),
        &body_file,
        payload.reopen,
    ));
    Ok(result)
}

struct CommentPayload {
    body: String,
    reopen: bool,
}

fn issue_comment_payload(value: Option<&Value>) -> Option<CommentPayload> {
    let object = value?.as_object()?;
    let body = object.get("body")?.as_str()?;
    if body.is_empty() {
        return None;
    }
    Some(CommentPayload {
        body: body.to_owned(),
        reopen: object.get("reopen").and_then(Value::as_bool) == Some(true),
    })
}

fn build_comment_fallback_command(issue_id: &str, body_file: &Path, reopen: bool) -> String {
    let mut command = format!(
        "rudder issue comment {} --body-file {}",
        shell_quote(issue_id),
        shell_quote(&body_file.to_string_lossy())
    );
    if reopen {
        command.push_str(" --reopen");
    }
    command.push_str(" --json");
    command
}

fn retire_expired_state(file_path: &Path, state: State, now: f64) -> io::Result<State> {
    cleanup_owned_comment_body_file(file_path, state.fallback_body_file.as_deref());
    let next = healthy_state(&state, now, state.generation + 1);
    write_state(file_path, &next)?;
    Ok(next)
}

fn healthy_state(state: &State, now: f64, generation: u64) -> State {
    State {
        operation: state.operation.clone(),
        scope_key: state.scope_key.clone(),
        issue_id: state.issue_id.clone(),
        fallback_command: None,
        fallback_body_file: None,
        generation,
        active_reservations: Vec::new(),
        phase: Phase::Healthy,
        initial_surface: state.initial_surface,
        probe_backoff: false,
        fallback_surface: None,
        fallback_matched_fingerprint: None,
        failure: None,
        observed_at: now,
        expires_at: HEALTHY_EXPIRY_MS as f64,
    }
}

fn state_from_scope(
    scope: &Scope,
    generation: u64,
    active_reservations: Vec<String>,
    phase: Phase,
    initial_surface: TransportSurface,
    observed_at: f64,
    expires_at: f64,
) -> State {
    State {
        operation: scope.operation.clone(),
        scope_key: scope.scope_key.clone(),
        issue_id: scope.issue_id.clone(),
        fallback_command: scope.fallback_command.clone(),
        fallback_body_file: scope.fallback_body_file.clone(),
        generation,
        active_reservations,
        phase,
        initial_surface,
        probe_backoff: false,
        fallback_surface: None,
        fallback_matched_fingerprint: None,
        failure: None,
        observed_at,
        expires_at,
    }
}

fn without_reservation(reservations: &[String], reservation_id: &str) -> Vec<String> {
    reservations
        .iter()
        .filter(|id| id.as_str() != reservation_id)
        .cloned()
        .collect()
}

fn cleanup_owned_comment_body_file(state_file_path: &Path, body_file: Option<&Path>) {
    let Some(body_file) = body_file else {
        return;
    };
    let (Some(parent), Some(state_base), Some(body_parent), Some(body_base)) = (
        state_file_path.parent(),
        state_file_path.file_stem().and_then(|value| value.to_str()),
        body_file.parent(),
        body_file.file_name().and_then(|value| value.to_str()),
    ) else {
        return;
    };
    if body_parent == parent
        && body_base.starts_with(&format!("{state_base}."))
        && body_base.ends_with(".comment.md")
    {
        let _ = fs::remove_file(body_file);
    }
}

fn storage_unavailable(
    scope: &Scope,
    surface: TransportSurface,
    _error: io::Error,
) -> BudgetFailure {
    BudgetFailure {
        status: 503,
        code: "issue_transport_unavailable".to_owned(),
        message: "Issue transport unavailable: local budget state unavailable".to_owned(),
        details: json!({
            "issueTransport": {
                "state": "blocked",
                "fingerprint": null,
                "operation": scope.operation,
                "scopeKey": scope.scope_key,
                "issueId": scope.issue_id,
                "upstreamStatus": null,
                "upstreamCode": null,
                "normalizedServerMessage": null,
                "initialSurface": surface.as_str(),
                "fallbackSurface": null,
                "fallbackMatchedFingerprint": null,
                "fallbackBudgetRemaining": 0,
                "fallbackAction": null,
                "retryAfterMs": DEFAULT_BACKOFF_MS,
                "checkpoint": "Issue transport unavailable"
            }
        }),
    }
}

fn should_gate_concurrent(scope: &Scope) -> bool {
    matches!(
        scope.operation.as_str(),
        "issue.list" | "issue.search" | "runs.list"
    )
}

fn transport_budget_operation(scope: &Scope) -> &str {
    if matches!(scope.operation.as_str(), "issue.list" | "issue.search") {
        "issue.collection"
    } else {
        &scope.operation
    }
}

fn is_legacy_issue_scope(scope: &Scope) -> bool {
    scope.operation.starts_with("issue.")
        && scope.issue_id.as_ref().is_some_and(|id| !id.is_empty())
}

fn is_legacy_issue_state(state: &State) -> bool {
    state.operation.starts_with("issue.")
        && state.issue_id.as_ref().is_some_and(|id| !id.is_empty())
}

fn next_reservation_id() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        now_ms() as u64,
        RESERVATION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut result, "{byte:02x}");
    }
    result
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)
    }
}

fn private_open_options() -> OpenOptions {
    let options = OpenOptions::new();
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = options;
        options.mode(0o600);
        options
    };
    options
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rudder-issue-budget-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create temporary state dir");
        path
    }

    fn budget(run_id: &str, surface: TransportSurface, state_dir: PathBuf) -> IssueTransportBudget {
        IssueTransportBudget::with_options(Some(run_id), surface, state_dir, 60_000)
    }

    fn allowed(outcome: ReserveOutcome) -> Reservation {
        match outcome {
            ReserveOutcome::Allowed(reservation) => reservation,
            other => panic!("expected an allowed reservation, got {other:?}"),
        }
    }

    #[test]
    fn classifies_only_scoped_issue_and_run_transport_operations() {
        let cases = [
            (Some("GET"), "/api/issues/iss_1", Some("issue.get")),
            (
                Some("GET"),
                "/api/issues/iss_1/heartbeat-context?wakeCommentId=cmt_1",
                Some("issue.context"),
            ),
            (
                Some("GET"),
                "/api/issues/iss_1/comments?order=desc",
                Some("issue.comments.list"),
            ),
            (
                Some("GET"),
                "/api/issues/iss_1/comments/cmt_1",
                Some("issue.comments.get"),
            ),
            (
                Some("POST"),
                "/api/issues/iss_1/comments",
                Some("issue.comment"),
            ),
            (
                Some("GET"),
                "/api/orgs/org_1/issues?projectId=prj_1&q=hello",
                Some("issue.search"),
            ),
            (
                Some("GET"),
                "/api/orgs/org_1/issues?projectId=prj_1",
                Some("issue.list"),
            ),
            (
                Some("GET"),
                "/api/run-intelligence/orgs/org_1/runs?issueId=iss_1",
                Some("runs.list"),
            ),
            (Some("POST"), "/api/issues/iss_1/checkout", None),
            (Some("PATCH"), "/api/issues/iss_1", None),
            (Some("GET"), "/api/issues/iss_1/unknown", None),
        ];
        for (method, path, expected) in cases {
            assert_eq!(
                request_scope(method, path).map(|scope| scope.operation),
                expected.map(str::to_owned),
                "{method:?} {path}"
            );
        }
    }

    #[test]
    fn list_and_search_share_org_project_budget_and_ignore_other_filters() {
        let list = request_scope(
            Some("GET"),
            "/api/orgs/org_1/issues?projectId=project%201&status=todo",
        )
        .expect("list scope");
        let search = request_scope(
            Some("GET"),
            "/api/orgs/org_1/issues?projectId=project%201&status=done&q=%20work%20",
        )
        .expect("search scope");
        assert_eq!(list.operation, "issue.list");
        assert_eq!(search.operation, "issue.search");
        assert_eq!(transport_budget_operation(&list), "issue.collection");
        assert_eq!(transport_budget_operation(&search), "issue.collection");
        assert_eq!(list.scope_key, "org:org_1|project:project 1");
        assert_eq!(list.scope_key, search.scope_key);
        assert!(should_gate_concurrent(&list));
        assert!(should_gate_concurrent(&search));
        let comment = request_scope(Some("GET"), "/api/issues/iss_1/comments?order=%20asc%20")
            .expect("comment list scope");
        assert_eq!(
            comment.fallback_command.as_deref(),
            Some("rudder issue comments list iss_1 --order ' asc ' --json")
        );
    }

    #[test]
    fn issue_state_filename_uses_the_shared_legacy_hash_key() {
        let dir = temp_dir("filename");
        let mcp = budget("run-1", TransportSurface::Mcp, dir.clone());
        let scope = request_scope(Some("GET"), "/api/issues/iss_1").unwrap();
        assert_eq!(
            mcp.state_file_path("run-1", &scope)
                .file_name()
                .unwrap()
                .to_string_lossy(),
            "df173bf286166ea8ff2f12bba82464b97fdef73a8cae5cd23ca5b8c56d7c743e.json"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mcp_failure_allows_one_cli_fallback_then_blocks_until_backoff() {
        let dir = temp_dir("shared-fallback");
        let mcp = budget("run-1", TransportSurface::Mcp, dir.clone());
        let cli = budget("run-1", TransportSurface::Cli, dir.clone());
        let path = "/api/issues/iss_1/comments?after=cmt_1&order=asc";
        let first = allowed(mcp.reserve(Some("GET"), path, None).unwrap());
        let failed = mcp
            .fail(
                Some(&first),
                500,
                "api_request_error",
                " Internal  server error ",
                None,
            )
            .unwrap();
        assert_eq!(failed.status, 500);
        assert_eq!(failed.code, "api_request_error");
        assert_eq!(
            failed.message,
            " Internal  server error ; use the equivalent Rudder CLI fallback once: rudder issue comments list iss_1 --after cmt_1 --order asc --json"
        );
        assert_eq!(
            failed.details.as_ref().unwrap()["issueTransport"]["state"],
            "fallback_available"
        );

        let fallback = allowed(cli.reserve(Some("GET"), path, None).unwrap());
        assert_eq!(fallback.attempt, Attempt::Fallback);
        let exhausted = cli
            .fail(
                Some(&fallback),
                500,
                "api_request_error",
                "Internal server error",
                None,
            )
            .unwrap();
        assert_eq!(exhausted.status, 500);
        assert_eq!(exhausted.code, "issue_transport_unavailable");
        assert_eq!(exhausted.message, "Issue transport unavailable");
        assert_eq!(
            exhausted.details.as_ref().unwrap()["issueTransport"]["fallbackMatchedFingerprint"],
            true
        );
        assert!(matches!(
            mcp.reserve(Some("GET"), path, None).unwrap(),
            ReserveOutcome::Blocked(BudgetFailure { status: 503, .. })
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn issue_comment_fallback_keeps_original_body_and_cleans_it_after_recovery() {
        let dir = temp_dir("comment-body");
        let mcp = budget("run-comment", TransportSurface::Mcp, dir.clone());
        let cli = budget("run-comment", TransportSurface::Cli, dir.clone());
        let body = json!({"body":"exact comment\ntext", "reopen":true});
        let initial = allowed(
            mcp.reserve(Some("POST"), "/api/issues/iss_2/comments", Some(&body))
                .unwrap(),
        );
        mcp.fail(
            Some(&initial),
            500,
            "api_request_error",
            "Internal server error",
            None,
        )
        .unwrap();
        let state = read_state(&initial.file_path).unwrap().unwrap();
        let body_file = state.fallback_body_file.unwrap();
        assert_eq!(
            fs::read_to_string(&body_file).unwrap(),
            "exact comment\ntext"
        );
        assert_eq!(
            state.fallback_command.as_deref(),
            Some(build_comment_fallback_command("iss_2", &body_file, true).as_str())
        );
        let fallback = allowed(
            cli.reserve(Some("POST"), "/api/issues/iss_2/comments", None)
                .unwrap(),
        );
        cli.succeed(Some(&fallback)).unwrap();
        assert!(!body_file.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_legacy_issue_state_without_scope_generation_or_reservations() {
        let dir = temp_dir("legacy-state");
        let cli = budget("legacy-run", TransportSurface::Cli, dir.clone());
        let scope = request_scope(Some("GET"), "/api/issues/iss_legacy").unwrap();
        let path = cli.state_file_path("legacy-run", &scope);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let normalized_message = "internal server error";
        let old_fingerprint = sha256_hex(
            format!("issue.get\niss_legacy\n500\napi_request_error\n{normalized_message}")
                .as_bytes(),
        );
        fs::write(
            &path,
            json!({
                "operation":"issue.get",
                "issueId":"iss_legacy",
                "phase":"fallback_available",
                "initialSurface":"mcp",
                "failure":{
                    "fingerprint":old_fingerprint,
                    "status":500,
                    "code":"api_request_error",
                    "normalizedMessage":normalized_message
                },
                "observedAt":now_ms(),
                "expiresAt":now_ms()+60_000.0
            })
            .to_string(),
        )
        .unwrap();

        let reservation = allowed(
            cli.reserve(Some("GET"), "/api/issues/iss_legacy", None)
                .unwrap(),
        );
        assert_eq!(reservation.attempt, Attempt::Fallback);
        let result = cli
            .fail(
                Some(&reservation),
                500,
                "api_request_error",
                "Internal server error",
                None,
            )
            .unwrap();
        assert_eq!(
            result.details.unwrap()["issueTransport"]["fallbackMatchedFingerprint"],
            true
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_5xx_uses_budget_and_successful_fallback_resets_failure() {
        let dir = temp_dir("status-reset");
        let mcp = budget("run-status", TransportSurface::Mcp, dir.clone());
        let cli = budget("run-status", TransportSurface::Cli, dir.clone());
        let first = allowed(mcp.reserve(Some("GET"), "/api/issues/iss_3", None).unwrap());
        mcp.fail(
            Some(&first),
            404,
            "not_found",
            "Issue not found",
            Some(&json!({"status":404})),
        )
        .unwrap();
        let state = read_state(&first.file_path).unwrap().unwrap();
        assert_eq!(state.phase, Phase::Healthy);

        let failed = allowed(mcp.reserve(Some("GET"), "/api/issues/iss_3", None).unwrap());
        mcp.fail(Some(&failed), 500, "api_request_error", "down", None)
            .unwrap();
        let fallback = allowed(cli.reserve(Some("GET"), "/api/issues/iss_3", None).unwrap());
        cli.succeed(Some(&fallback)).unwrap();
        let state = read_state(&failed.file_path).unwrap().unwrap();
        assert_eq!(state.phase, Phase::Healthy);
        assert!(state.failure.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expired_blocked_budget_starts_a_fresh_generation() {
        let dir = temp_dir("backoff-expired");
        let mcp = budget("run-expired", TransportSurface::Mcp, dir.clone());
        let scope = request_scope(Some("GET"), "/api/issues/iss_4").unwrap();
        let path = mcp.state_file_path("run-expired", &scope);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            json!({
                "operation":"issue.get",
                "scopeKey":"issue:iss_4",
                "generation":2,
                "activeReservations":[],
                "phase":"blocked",
                "initialSurface":"mcp",
                "failure":{"fingerprint":"f","status":500,"code":"x","normalizedMessage":"x"},
                "observedAt":1,
                "expiresAt":0
            })
            .to_string(),
        )
        .unwrap();
        let reservation = allowed(mcp.reserve(Some("GET"), "/api/issues/iss_4", None).unwrap());
        assert_eq!(reservation.generation, 4);
        assert_eq!(
            read_state(&path).unwrap().unwrap().phase,
            Phase::RequestInFlight
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn collection_waiters_are_released_only_after_probe_result() {
        let dir = temp_dir("collection-gate");
        let mcp = budget("run-collection-failure", TransportSurface::Mcp, dir.clone());
        let first = allowed(
            mcp.reserve(
                Some("GET"),
                "/api/orgs/org_1/issues?projectId=project_1&q=first",
                None,
            )
            .unwrap(),
        );
        assert_eq!(
            read_state(&first.file_path).unwrap().unwrap().phase,
            Phase::ProbeInFlight
        );
        let waiting_budget = mcp.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (outcome_tx, outcome_rx) = std::sync::mpsc::channel();
        let waiting = thread::spawn(move || {
            started_tx.send(()).unwrap();
            outcome_tx
                .send(waiting_budget.reserve(
                    Some("GET"),
                    "/api/orgs/org_1/issues?projectId=project_1&q=second",
                    None,
                ))
                .unwrap();
        });
        started_rx.recv().unwrap();
        assert!(outcome_rx.recv_timeout(Duration::from_millis(50)).is_err());
        mcp.fail(
            Some(&first),
            500,
            "api_request_error",
            "Internal server error",
            None,
        )
        .unwrap();
        let outcome = outcome_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("probe failure releases waiter")
            .unwrap();
        assert!(matches!(
            outcome,
            ReserveOutcome::Blocked(BudgetFailure { status: 503, .. })
        ));
        waiting.join().unwrap();

        let success_budget = budget("run-collection-success", TransportSurface::Mcp, dir.clone());
        let probe = allowed(
            success_budget
                .reserve(
                    Some("GET"),
                    "/api/orgs/org_1/issues?projectId=project_1",
                    None,
                )
                .unwrap(),
        );
        let waiting_budget = success_budget.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (outcome_tx, outcome_rx) = std::sync::mpsc::channel();
        let waiting = thread::spawn(move || {
            started_tx.send(()).unwrap();
            outcome_tx
                .send(waiting_budget.reserve(
                    Some("GET"),
                    "/api/orgs/org_1/issues?projectId=project_1&status=todo",
                    None,
                ))
                .unwrap();
        });
        started_rx.recv().unwrap();
        assert!(outcome_rx.recv_timeout(Duration::from_millis(50)).is_err());
        success_budget.succeed(Some(&probe)).unwrap();
        let outcome = outcome_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("probe success releases waiter")
            .unwrap();
        let next = allowed(outcome);
        success_budget.succeed(Some(&next)).unwrap();
        waiting.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn absent_run_and_non_budgeted_lifecycle_calls_are_not_recorded() {
        let dir = temp_dir("untracked");
        let no_run =
            IssueTransportBudget::with_options(None, TransportSurface::Mcp, dir.clone(), 1);
        assert!(matches!(
            no_run
                .reserve(Some("GET"), "/api/issues/iss_1", None)
                .unwrap(),
            ReserveOutcome::Untracked
        ));
        let mcp = budget("run-untracked", TransportSurface::Mcp, dir.clone());
        assert!(matches!(
            mcp.reserve(Some("PATCH"), "/api/issues/iss_1", None)
                .unwrap(),
            ReserveOutcome::Untracked
        ));
        assert!(!dir.join("issue-transport-budget").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
