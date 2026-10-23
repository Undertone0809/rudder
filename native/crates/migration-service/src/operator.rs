//! Shared explicit operator contract; never invoked by read-only preflight.
use crate::{
    MigrationApplyService, MigrationPreflightReport, MigrationPreflightService,
    MigrationPreflightStatus, MigrationRecoveryPointReceipt,
};
use rudder_migration_core::{
    MigrationInspectionOptions, MigrationManifest, MigrationManifestOptions, MigrationSource,
    inspect_migration_source,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    future::Future,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    pin::Pin,
    process::Stdio,
    str::FromStr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const SCHEMA: &str = "rudder.migration-apply/v1";
const MAX_INPUT: u64 = 256 * 1024;
const MAX_BACKUP: u64 = 4 * 1024 * 1024 * 1024;
const BACKUP_JOURNAL_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) type BackupJournalLookupFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<String>, sqlx::Error>> + Send + 'a>>;

pub(crate) trait BackupJournalReader: Send + Sync {
    fn lookup<'a>(
        &'a self,
        connection: &'a mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    ) -> BackupJournalLookupFuture<'a>;
}

struct PostgresBackupJournalReader;

impl BackupJournalReader for PostgresBackupJournalReader {
    fn lookup<'a>(
        &'a self,
        connection: &'a mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    ) -> BackupJournalLookupFuture<'a> {
        Box::pin(sqlx::query_scalar::<_, String>(
            "SELECT table_schema FROM information_schema.tables WHERE table_name = '__drizzle_migrations' AND table_schema IN ('drizzle', 'public') ORDER BY CASE WHEN table_schema = 'drizzle' THEN 0 ELSE 1 END LIMIT 1",
        ).fetch_optional(&mut **connection))
    }
}

enum BackupJournalLookupOutcome {
    Cancelled,
    TimedOut,
    Query(Result<Option<String>, sqlx::Error>),
}

async fn await_cancellable_database_io<T, F>(
    cancellation: &CancellationToken,
    operation: F,
    failure: &'static str,
) -> Result<T, &'static str>
where
    F: Future<Output = Result<T, sqlx::Error>>,
{
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("cancellation_cleanup_unconfirmed"),
        result = tokio::time::timeout(Duration::from_secs(5), operation) => {
            result.map_err(|_| failure)?.map_err(|_| failure)
        }
    }
}

async fn lookup_backup_journal_schema(
    pool: &sqlx::PgPool,
    control_pool: &sqlx::PgPool,
    cancellation: &CancellationToken,
) -> Result<String, &'static str> {
    lookup_backup_journal_schema_with_reader(
        pool,
        control_pool,
        cancellation,
        &PostgresBackupJournalReader,
    )
    .await
}

async fn lookup_backup_journal_schema_with_reader(
    pool: &sqlx::PgPool,
    control_pool: &sqlx::PgPool,
    cancellation: &CancellationToken,
    reader: &dyn BackupJournalReader,
) -> Result<String, &'static str> {
    if cancellation.is_cancelled() {
        return Err("operation_aborted");
    }
    let mut connection = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err("operation_aborted"),
        result = tokio::time::timeout(BACKUP_JOURNAL_LOOKUP_TIMEOUT, pool.acquire()) => {
            result.map_err(|_| "backup_journal_lookup_failed")?
                .map_err(|_| "backup_journal_lookup_failed")?
        }
    };
    connection.close_on_drop();
    let correlation_result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => None,
        result = tokio::time::timeout(
            BACKUP_JOURNAL_LOOKUP_TIMEOUT,
            crate::apply::assign_backend_correlation(&mut connection),
        ) => Some(result),
    };
    let correlation = match correlation_result {
        Some(Ok(Ok(correlation))) => correlation,
        Some(Ok(Err(_))) | Some(Err(_)) | None => {
            let _ = crate::apply::close_unidentified_backend(connection).await;
            return Err("cancellation_cleanup_unconfirmed");
        }
    };
    let outcome = tokio::select! {
        biased;
        _ = cancellation.cancelled() => BackupJournalLookupOutcome::Cancelled,
        result = tokio::time::timeout(BACKUP_JOURNAL_LOOKUP_TIMEOUT, reader.lookup(&mut connection)) => {
            match result {
                Err(_) => BackupJournalLookupOutcome::TimedOut,
                Ok(result) => BackupJournalLookupOutcome::Query(result),
            }
        }
    };
    crate::apply::close_correlated_backend(connection, control_pool, &correlation)
        .await
        .map_err(|_| "cancellation_cleanup_unconfirmed")?;
    match outcome {
        BackupJournalLookupOutcome::Cancelled => Err("operation_aborted"),
        BackupJournalLookupOutcome::TimedOut => Err("backup_journal_lookup_failed"),
        BackupJournalLookupOutcome::Query(Ok(Some(schema))) => Ok(schema),
        BackupJournalLookupOutcome::Query(Ok(None)) => Err("backup_journal_missing"),
        BackupJournalLookupOutcome::Query(Err(_)) => Err("backup_journal_lookup_failed"),
    }
}

/// pg_dump runs in its own Unix process group so cancelling the operator also
/// terminates any helper processes it started. Windows uses a kill-on-close
/// Job Object instead.
#[cfg(unix)]
struct BackupProcessGroup {
    process_group_id: i32,
    armed: bool,
}

#[cfg(unix)]
impl BackupProcessGroup {
    fn new(process_id: u32) -> io::Result<Self> {
        let process_group_id = i32::try_from(process_id)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid child PID"))?;
        if process_group_id <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid child PID",
            ));
        }
        Ok(Self {
            process_group_id,
            armed: true,
        })
    }

    fn terminate_remaining(&mut self) -> io::Result<()> {
        if unsafe { libc::kill(-self.process_group_id, libc::SIGKILL) } == 0 {
            self.armed = false;
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            self.armed = false;
            Ok(())
        } else {
            Err(error)
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(unix)]
impl Drop for BackupProcessGroup {
    fn drop(&mut self) {
        if self.armed {
            // The direct pg_dump child is still in this group until it exits,
            // so the group ID cannot have been recycled on this cancellation
            // path. `kill_on_drop` remains a second line of defense for it.
            unsafe { libc::kill(-self.process_group_id, libc::SIGKILL) };
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    schema: String,
    protocol_version: u8,
    allow_apply: bool,
    #[serde(default)]
    validate_only: bool,
    migrations_dir: PathBuf,
    expected_fingerprint: String,
    recovery_directory: PathBuf,
    pg_dump_binary: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_gate: Option<StartupGateRequest>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupMigrationPolicy {
    Automatic,
    Never,
    Prompt,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StartupGateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    policy: Option<StartupMigrationPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    facts: Option<StartupGateFacts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<StartupApproval>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StartupGateFacts {
    auto_apply_requested: bool,
    prompt_never: bool,
    interactive: bool,
    #[serde(default)]
    embedded_cluster_initialized_before_startup: Option<bool>,
    #[serde(default)]
    application_database_created: Option<bool>,
}

impl StartupGateRequest {
    fn effective_policy(&self) -> Option<StartupMigrationPolicy> {
        match (self.policy, self.facts) {
            (Some(policy), None) => Some(policy),
            (None, Some(facts)) if facts.auto_apply_requested => {
                Some(StartupMigrationPolicy::Automatic)
            }
            (None, Some(facts)) if facts.prompt_never => Some(StartupMigrationPolicy::Never),
            (None, Some(facts)) if !facts.interactive => Some(StartupMigrationPolicy::Automatic),
            (None, Some(_)) => Some(StartupMigrationPolicy::Prompt),
            _ => None,
        }
    }

    fn should_auto_apply_fresh_bootstrap(&self, report: &MigrationPreflightReport) -> bool {
        let Some(facts) = self.facts else {
            return false;
        };
        !facts.auto_apply_requested
            && !facts.prompt_never
            && facts.interactive
            && (facts.embedded_cluster_initialized_before_startup == Some(false)
                || facts.application_database_created == Some(true))
            && report.status == MigrationPreflightStatus::Bootstrap
            && report.table_count == 0
            && report.pending_legacy_column_renames.is_empty()
            && report.legacy_column_conflicts.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StartupApproval {
    state_token: String,
    approved: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StartupMigrationOutcome {
    Complete {
        report: crate::MigrationApplyReport,
    },
    ApprovalRequired {
        #[serde(rename = "stateToken")]
        state_token: String,
        #[serde(rename = "pendingMigrations")]
        pending_migrations: Vec<String>,
    },
    Declined,
    Refused {
        #[serde(rename = "pendingMigrations")]
        pending_migrations: Vec<String>,
    },
    StaleApproval,
}

pub fn startup_approval_token(database_url: &str, report: &MigrationPreflightReport) -> String {
    let serialized = serde_json::to_vec(report).expect("preflight report is serializable");
    let mut hasher = Sha256::new();
    hasher.update(b"rudder-startup-migration-approval-v1\0");
    // Bind the approval to the configured target without exposing credentials
    // or the URL through the returned token or operator diagnostics.
    hasher.update((database_url.len() as u64).to_be_bytes());
    hasher.update(database_url.as_bytes());
    hasher.update(serialized);
    format!("{:x}", hasher.finalize())
}

struct PreparedOperatorInput {
    request: Request,
    source: MigrationSource,
    manifest: MigrationManifest,
}

/// The explicit CLI operation selected by a fully validated request and
/// pinned migration source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperatorInputMode {
    Apply,
    ValidateOnly,
    StartupGate,
}

fn absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
}

fn parse(input: &[u8]) -> Result<Request, &'static str> {
    let request: Request = serde_json::from_slice(input).map_err(|_| "invalid_request")?;
    if request.schema != SCHEMA || request.protocol_version != 1 || !request.allow_apply {
        return Err("explicit_apply_contract_required");
    }
    if !absolute_path(&request.migrations_dir)
        || !absolute_path(&request.recovery_directory)
        || !absolute_path(&request.pg_dump_binary)
    {
        return Err("absolute_normalized_paths_required");
    }
    if request.expected_fingerprint.len() != 64
        || !request
            .expected_fingerprint
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("manifest_fingerprint_required");
    }
    if request.startup_gate.as_ref().is_some_and(|gate| {
        let Some(policy) = gate.effective_policy() else {
            return true;
        };
        request.validate_only
            || match (policy, gate.approval.as_ref()) {
                (StartupMigrationPolicy::Prompt, Some(approval)) => {
                    approval.state_token.len() != 64
                        || !approval
                            .state_token
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                }
                (StartupMigrationPolicy::Prompt, None)
                | (StartupMigrationPolicy::Automatic, None)
                | (StartupMigrationPolicy::Never, None) => false,
                _ => true,
            }
    }) {
        return Err("startup_gate_request_invalid");
    }
    Ok(request)
}

/// Parse and inspect the pinned migration source before resolving credentials
/// or opening a database. Keep this as the single source-validation path shared
/// by the CLI and startup gate so their error precedence cannot drift.
fn prepare_operator_input(input: &[u8]) -> Result<PreparedOperatorInput, &'static str> {
    if input.len() as u64 > MAX_INPUT {
        return Err("input_too_large");
    }
    let request = parse(input)?;
    let source = MigrationSource::new(&request.migrations_dir);
    let manifest = inspect_migration_source(
        &source,
        &MigrationInspectionOptions {
            manifest: MigrationManifestOptions::default(),
            expected_fingerprint: Some(request.expected_fingerprint.clone()),
        },
    )
    .map_err(|_| "migration_source_invalid")?;
    if !manifest.validate_integrity().valid {
        return Err("migration_manifest_invalid");
    }
    Ok(PreparedOperatorInput {
        request,
        source,
        manifest,
    })
}

/// Validate the full operator request and pinned source and classify its mode
/// before resolving credentials or opening a database.
pub fn validate_operator_mode(input: &[u8]) -> Result<OperatorInputMode, &'static str> {
    prepare_operator_input(input).map(|prepared| {
        if prepared.request.startup_gate.is_some() {
            OperatorInputMode::StartupGate
        } else if prepared.request.validate_only {
            OperatorInputMode::ValidateOnly
        } else {
            OperatorInputMode::Apply
        }
    })
}

/// Backward-compatible validation helper for callers that only need the
/// validate-only bit.
pub fn validate_operator_input(input: &[u8]) -> Result<bool, &'static str> {
    validate_operator_mode(input).map(|mode| mode == OperatorInputMode::ValidateOnly)
}

/// Reports whether a pinned, valid request uses the startup approval gate.
pub fn is_startup_gate_input(input: &[u8]) -> Result<bool, &'static str> {
    validate_operator_mode(input).map(|mode| mode == OperatorInputMode::StartupGate)
}

/// Execute the pinned migration operator contract in-process.
/// This is shared by the explicit CLI and native startup, never a fallback.
pub async fn apply_operator(
    input: &[u8],
    database_url: &str,
) -> Result<crate::MigrationApplyReport, &'static str> {
    apply_operator_cancellable(input, database_url, CancellationToken::new()).await
}

/// Execute the explicit migration operator while preserving the active SQL
/// future when its managed parent or caller requests cancellation.
pub async fn apply_operator_cancellable(
    input: &[u8],
    database_url: &str,
    cancellation: CancellationToken,
) -> Result<crate::MigrationApplyReport, &'static str> {
    apply_operator_cancellable_inner(input, database_url, cancellation, None).await
}

/// Applies a migration only when its locked database snapshot still matches
/// the one presented for startup approval.
pub async fn apply_operator_cancellable_after_approval(
    input: &[u8],
    database_url: &str,
    cancellation: CancellationToken,
    expected_state_token: &str,
) -> Result<crate::MigrationApplyReport, &'static str> {
    apply_operator_cancellable_inner(
        input,
        database_url,
        cancellation,
        Some(expected_state_token),
    )
    .await
}

async fn apply_operator_cancellable_inner(
    input: &[u8],
    database_url: &str,
    cancellation: CancellationToken,
    expected_state_token: Option<&str>,
) -> Result<crate::MigrationApplyReport, &'static str> {
    let PreparedOperatorInput {
        request,
        source,
        manifest,
    } = prepare_operator_input(input)?;
    if request.validate_only {
        return Err("validation_only_request");
    }
    if request.startup_gate.is_some() != expected_state_token.is_some() {
        return Err("startup_gate_requires_gate_operator");
    }
    if cancellation.is_cancelled() {
        return Err("operation_aborted");
    }
    if database_url.len() > 8192
        || !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://"))
    {
        return Err("database_url_invalid");
    }
    // This operator is also called directly from the standalone Rust server
    // startup path. Install the process-tree boundary here so both startup and
    // the explicit CLI protect pg_dump from abrupt Windows parent termination.
    #[cfg(windows)]
    crate::ensure_process_tree_guard().map_err(|_| "process_tree_guard_unavailable")?;

    let application_name = format!("rudder-migration-{}", uuid::Uuid::new_v4().simple());
    let options = PgConnectOptions::from_str(database_url)
        .map_err(|_| "database_url_invalid")?
        .application_name(&application_name);
    let pool = await_cancellable_database_io(
        &cancellation,
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options.clone()),
        "database_connect_failed",
    )
    .await?;
    // Cancellation control uses a distinct session so it can signal the exact
    // migration backend while that backend is busy executing SQL.
    let control_pool = match await_cancellable_database_io(
        &cancellation,
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(
                options
                    .clone()
                    .application_name("rudder-migration-cancel-control"),
            ),
        "database_connect_failed",
    )
    .await
    {
        Ok(pool) => pool,
        Err(error) => {
            pool.close().await;
            return Err(error);
        }
    };
    let backup_pool = match await_cancellable_database_io(
        &cancellation,
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options.clone().application_name("rudder-migration-backup")),
        "database_connect_failed",
    )
    .await
    {
        Ok(pool) => pool,
        Err(error) => {
            control_pool.close().await;
            pool.close().await;
            return Err(error);
        }
    };
    let backup_cancellation = cancellation.clone();
    let backup_lookup_pool = backup_pool.clone();
    let backup_control_pool = control_pool.clone();
    let writer = MigrationApplyService::new(pool.clone());
    let create_recovery_point = || async move {
        let schema = lookup_backup_journal_schema(
            &backup_lookup_pool,
            &backup_control_pool,
            &backup_cancellation,
        )
        .await
        .map_err(str::to_owned)?;
        backup_lookup_pool.close().await;
        create_backup(
            &request.recovery_directory,
            &request.pg_dump_binary,
            database_url,
            &schema,
            backup_cancellation,
        )
        .await
        .map_err(str::to_owned)
    };
    let result = if let Some(expected_state_token) = expected_state_token {
        writer
            .apply_pending_migrations_cancellable_after_approval(
                &manifest,
                &source,
                cancellation,
                &control_pool,
                expected_state_token,
                database_url,
                create_recovery_point,
            )
            .await
    } else {
        writer
            .apply_pending_migrations_cancellable(
                &manifest,
                &source,
                cancellation,
                &control_pool,
                create_recovery_point,
            )
            .await
    };
    backup_pool.close().await;
    control_pool.close().await;
    pool.close().await;
    result.map_err(|error| match error {
        crate::MigrationApplyError::ManifestChanged => "migration_source_changed",
        crate::MigrationApplyError::ApplyRequired => "requires_apply",
        crate::MigrationApplyError::ApprovalStateChanged => "approval_state_changed",
        crate::MigrationApplyError::LegacyColumnCollision(_) => "legacy_column_conflict",
        crate::MigrationApplyError::LegacyColumnsChanged => "legacy_columns_changed",
        crate::MigrationApplyError::RecoveryPointProvider(reason)
            if reason == "recovery_point_invalid" =>
        {
            "recovery_point_invalid"
        }
        crate::MigrationApplyError::RecoveryPointProvider(_) => "recovery_point_failed",
        crate::MigrationApplyError::InvalidRecoveryPoint(_) => "recovery_point_invalid",
        crate::MigrationApplyError::UnsafeLegacyDatabase => "unsafe_legacy_database",
        crate::MigrationApplyError::OperationCancelled => "operation_aborted",
        crate::MigrationApplyError::BackendIdentityTimeout => "backend_identity_timeout",
        crate::MigrationApplyError::CancellationCleanupUnconfirmed => {
            "cancellation_cleanup_unconfirmed"
        }
        _ => "migration_apply_failed",
    })
}

/// Rust owns the startup migration decision. Interactive approval is requested
/// without holding a PostgreSQL advisory lock; an approval is bound to the
/// exact repeatable-read state and verified again under the writer lock.
pub async fn startup_operator_cancellable(
    input: &[u8],
    database_url: &str,
    cancellation: CancellationToken,
) -> Result<StartupMigrationOutcome, &'static str> {
    let prepared = prepare_operator_input(input)?;
    let gate = prepared
        .request
        .startup_gate
        .clone()
        .ok_or("startup_gate_request_required")?;
    let policy = gate
        .effective_policy()
        .ok_or("startup_gate_request_invalid")?;

    if let Some(approval) = gate.approval.clone() {
        if !approval.approved {
            return Ok(StartupMigrationOutcome::Declined);
        }
        return match apply_operator_cancellable_after_approval(
            input,
            database_url,
            cancellation,
            &approval.state_token,
        )
        .await
        {
            Ok(report) => Ok(StartupMigrationOutcome::Complete { report }),
            Err("approval_state_changed") => Ok(StartupMigrationOutcome::StaleApproval),
            Err(error) => Err(error),
        };
    }

    if policy == StartupMigrationPolicy::Automatic {
        return apply_startup_automatic(input, database_url, cancellation)
            .await
            .map(|report| StartupMigrationOutcome::Complete { report });
    }

    for _ in 0..3 {
        let report = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err("operation_aborted"),
            report = inspect_startup_state(&prepared, database_url) => report?,
        };
        if !report.legacy_column_conflicts.is_empty() {
            return Err("legacy_column_conflict");
        }
        match report.status {
            MigrationPreflightStatus::UnsafeLegacy => return Err("unsafe_legacy_database"),
            MigrationPreflightStatus::MissingCoreSchema => return Err("missing_core_schema"),
            MigrationPreflightStatus::Mismatch => {
                return Err(
                    if matches!(
                    report.history.reason,
                    rudder_migration_history_core::MigrationHistoryReason::MigrationJournalInvalid
                ) {
                        "migration_journal_invalid"
                    } else {
                        "migration_history_mismatch"
                    },
                );
            }
            MigrationPreflightStatus::Current
                if report.pending_legacy_column_renames.is_empty() =>
            {
                let validation_input = validation_request(&prepared.request)?;
                let validation = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err("operation_aborted"),
                    result = validate_operator(&validation_input, database_url) => result,
                };
                match validation {
                    Ok(report) => {
                        return Ok(StartupMigrationOutcome::Complete { report });
                    }
                    Err("requires_apply") => continue,
                    Err(error) => return Err(error),
                }
            }
            MigrationPreflightStatus::Bootstrap
            | MigrationPreflightStatus::Pending
            | MigrationPreflightStatus::Current => {}
        }

        if policy == StartupMigrationPolicy::Prompt
            && gate.should_auto_apply_fresh_bootstrap(&report)
        {
            return apply_startup_automatic(input, database_url, cancellation)
                .await
                .map(|report| StartupMigrationOutcome::Complete { report });
        }

        let pending_migrations = pending_migration_names(&report, &prepared.manifest);
        if pending_migrations.is_empty() {
            return Err("migration_state_invalid");
        }
        return Ok(match policy {
            StartupMigrationPolicy::Prompt => StartupMigrationOutcome::ApprovalRequired {
                state_token: startup_approval_token(database_url, &report),
                pending_migrations,
            },
            StartupMigrationPolicy::Never => {
                StartupMigrationOutcome::Refused { pending_migrations }
            }
            StartupMigrationPolicy::Automatic => unreachable!("automatic mode returned above"),
        });
    }
    Err("migration_state_changed_repeatedly")
}

async fn apply_startup_automatic(
    input: &[u8],
    database_url: &str,
    cancellation: CancellationToken,
) -> Result<crate::MigrationApplyReport, &'static str> {
    let mut request = prepare_operator_input(input)?.request;
    request.startup_gate = None;
    let apply_input = serde_json::to_vec(&request).map_err(|_| "migration_request_invalid")?;
    apply_operator_cancellable(&apply_input, database_url, cancellation).await
}

fn pending_migration_names(
    report: &MigrationPreflightReport,
    manifest: &MigrationManifest,
) -> Vec<String> {
    let mut pending = if report.status == MigrationPreflightStatus::Bootstrap {
        manifest
            .entries
            .iter()
            .map(|entry| entry.file_name.clone())
            .collect::<Vec<_>>()
    } else {
        report
            .history
            .pending_migrations
            .iter()
            .map(|migration| migration.file_name.clone())
            .collect::<Vec<_>>()
    };
    for legacy_column in &report.pending_legacy_column_renames {
        if !pending.contains(legacy_column) {
            pending.push(legacy_column.clone());
        }
    }
    pending
}

fn validation_request(request: &Request) -> Result<Vec<u8>, &'static str> {
    let mut validation = request.clone();
    validation.validate_only = true;
    validation.startup_gate = None;
    serde_json::to_vec(&validation).map_err(|_| "validation_request_invalid")
}

async fn inspect_startup_state(
    prepared: &PreparedOperatorInput,
    database_url: &str,
) -> Result<MigrationPreflightReport, &'static str> {
    if database_url.len() > 8192
        || !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://"))
    {
        return Err("database_url_invalid");
    }
    let connect_options = PgConnectOptions::from_str(database_url)
        .map(|options| options.application_name("rudder-migration-startup-gate"))
        .map_err(|_| "database_url_invalid")?;
    let pool = tokio::time::timeout(
        Duration::from_secs(5),
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(connect_options),
    )
    .await
    .map_err(|_| "database_connect_failed")?
    .map_err(|_| "database_connect_failed")?;
    let result = MigrationPreflightService::new(pool.clone())
        .preflight(&prepared.manifest)
        .await
        .map_err(|_| "migration_preflight_failed");
    pool.close().await;
    let report = result?;
    if report.history.manifest_fingerprint != prepared.manifest.fingerprint {
        return Err("migration_source_changed");
    }
    Ok(report)
}

/// Validate that a current database satisfies Rust's locked invariants without
/// invoking backup or migration writers. The request must explicitly set
/// `validateOnly: true`.
pub async fn validate_operator(
    input: &[u8],
    database_url: &str,
) -> Result<crate::MigrationApplyReport, &'static str> {
    let PreparedOperatorInput {
        request,
        source,
        manifest,
    } = prepare_operator_input(input)?;
    if !request.validate_only {
        return Err("validation_only_request_required");
    }
    if database_url.len() > 8192
        || !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://"))
    {
        return Err("database_url_invalid");
    }
    let options = PgConnectOptions::from_str(database_url)
        .map_err(|_| "database_url_invalid")?
        .application_name("rudder-migration-validate");
    let pool = tokio::time::timeout(
        Duration::from_secs(5),
        PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options),
    )
    .await
    .map_err(|_| "database_connect_failed")?
    .map_err(|_| "database_connect_failed")?;
    let result = MigrationApplyService::new(pool.clone())
        .validate_current_state(&manifest, &source)
        .await;
    pool.close().await;
    result.map_err(|error| match error {
        crate::MigrationApplyError::ManifestChanged => "migration_source_changed",
        crate::MigrationApplyError::ApplyRequired => "requires_apply",
        crate::MigrationApplyError::UnsafeLegacyDatabase => "unsafe_legacy_database",
        _ => "migration_validation_failed",
    })
}

// libpq does not expand a URI supplied through PGDATABASE. Derive explicit
// environment settings instead; passwords never appear in child arguments.
fn backup_connection_env(database_url: &str) -> Result<Vec<(String, String)>, &'static str> {
    let url = url::Url::parse(database_url).map_err(|_| "database_url_invalid")?;
    let options = PgConnectOptions::from_str(database_url).map_err(|_| "database_url_invalid")?;
    let host = options
        .get_socket()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| options.get_host().to_owned());
    let mut values = vec![
        ("PGHOST".into(), host),
        ("PGPORT".into(), options.get_port().to_string()),
        ("PGUSER".into(), options.get_username().to_owned()),
        (
            "PGDATABASE".into(),
            options
                .get_database()
                .unwrap_or(options.get_username())
                .to_owned(),
        ),
        ("PGCONNECT_TIMEOUT".into(), "5".into()),
        (
            "PGSSLMODE".into(),
            match options.get_ssl_mode() {
                sqlx::postgres::PgSslMode::Disable => "disable",
                sqlx::postgres::PgSslMode::Allow => "allow",
                sqlx::postgres::PgSslMode::Prefer => "prefer",
                sqlx::postgres::PgSslMode::Require => "require",
                sqlx::postgres::PgSslMode::VerifyCa => "verify-ca",
                sqlx::postgres::PgSslMode::VerifyFull => "verify-full",
            }
            .into(),
        ),
    ];
    if let Some(password) = url.password() {
        values.push((
            "PGPASSWORD".into(),
            percent_encoding::percent_decode_str(password)
                .decode_utf8()
                .map_err(|_| "database_url_invalid")?
                .into_owned(),
        ));
    }
    if let Some(options) = options.get_options() {
        values.push(("PGOPTIONS".into(), options.to_owned()));
    }
    for (key, value) in url.query_pairs() {
        let env_key = match key.as_ref() {
            "password" => "PGPASSWORD",
            "sslrootcert" | "ssl-root-cert" | "ssl-ca" => "PGSSLROOTCERT",
            "sslcert" | "ssl-cert" => "PGSSLCERT",
            "sslkey" | "ssl-key" => "PGSSLKEY",
            _ => continue,
        };
        values.push((env_key.into(), value.into_owned()));
    }
    Ok(values)
}

async fn create_backup(
    directory: &Path,
    binary: &Path,
    database_url: &str,
    _journal_schema: &str,
    cancellation: CancellationToken,
) -> Result<MigrationRecoveryPointReceipt, &'static str> {
    let inherited_environment = std::env::vars_os().collect::<Vec<_>>();
    create_backup_with_environment_cancellable(
        directory,
        binary,
        database_url,
        &inherited_environment,
        cancellation,
    )
    .await
}

#[cfg(test)]
async fn create_backup_with_environment(
    directory: &Path,
    binary: &Path,
    database_url: &str,
    inherited_environment: &[(OsString, OsString)],
) -> Result<MigrationRecoveryPointReceipt, &'static str> {
    create_backup_with_environment_cancellable(
        directory,
        binary,
        database_url,
        inherited_environment,
        CancellationToken::new(),
    )
    .await
}

async fn create_backup_with_environment_cancellable(
    directory: &Path,
    binary: &Path,
    database_url: &str,
    inherited_environment: &[(OsString, OsString)],
    cancellation: CancellationToken,
) -> Result<MigrationRecoveryPointReceipt, &'static str> {
    // This operator-selected directory is private. Reject a symlink as its
    // final component and never truncate an existing recovery point.
    fs::create_dir_all(directory).map_err(|_| "backup_directory_failed")?;
    if fs::symlink_metadata(directory)
        .map_err(|_| "backup_directory_failed")?
        .file_type()
        .is_symlink()
    {
        return Err("backup_directory_symlink");
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "clock_invalid")?
        .as_nanos();
    let filename = format!("pre-migration-{stamp}-{}.sql", std::process::id());
    let final_path = directory.join(&filename);
    let partial = directory.join(format!("{filename}.partial"));
    if cancellation.is_cancelled() {
        return Err("operation_aborted");
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&partial).map_err(|_| "backup_file_failed")?;
    writeln!(file, "-- Rudder database backup\n-- Full PostgreSQL SQL dump follows; retain until upgrade acceptance.").map_err(|_| "backup_file_failed")?;
    // Connection credentials remain in the child environment, never argv or
    // logs. The full dump includes the journal and all application schemas.
    let mut command = Command::new(binary);
    // Startup also carries auth and upstream secrets. Only runtime/home paths
    // needed by the selected pg_dump and its existing libpq credential files
    // survive; application environment and ambient PG overrides do not.
    command.env_clear();
    command.envs(backup_process_environment(
        database_url,
        inherited_environment,
    )?);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    let mut child = match command
        .args([
            "--format=plain",
            "--no-owner",
            "--no-privileges",
            "--no-password",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            // Drop the command's output handle before unlinking on Windows.
            drop(command);
            fs::remove_file(&partial).map_err(|_| "backup_partial_cleanup_failed")?;
            return Err("backup_process_failed");
        }
    };
    // Release the command's configured output file handle before any later
    // partial-backup cleanup (notably on Windows).
    drop(command);
    #[cfg(unix)]
    let mut process_group = BackupProcessGroup::new(child.id().ok_or("backup_process_failed")?)
        .map_err(|_| "backup_process_failed")?;
    let started = tokio::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "backup_process_failed")? {
            break status;
        }
        let too_large = fs::metadata(&partial)
            .map_err(|_| "backup_read_failed")?
            .len()
            > MAX_BACKUP;
        if too_large || started.elapsed() > Duration::from_secs(600) {
            #[cfg(unix)]
            process_group
                .terminate_remaining()
                .map_err(|_| "backup_process_cleanup_failed")?;
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(if too_large {
                "backup_size_invalid"
            } else {
                "backup_timeout"
            });
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                #[cfg(unix)]
                process_group
                    .terminate_remaining()
                    .map_err(|_| "backup_process_cleanup_failed")?;
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = fs::remove_file(&partial);
                return Err("operation_aborted");
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    };
    #[cfg(unix)]
    process_group.disarm();
    if !status.success() {
        fs::remove_file(&partial).map_err(|_| "backup_partial_cleanup_failed")?;
        return Err("backup_process_failed");
    }
    tokio::task::spawn_blocking(move || finish_backup(&partial, &final_path))
        .await
        .map_err(|_| "backup_finalize_failed")?
}

fn backup_process_environment(
    database_url: &str,
    inherited_environment: &[(OsString, OsString)],
) -> Result<Vec<(OsString, OsString)>, &'static str> {
    let mut environment = Vec::new();
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
    ] {
        if let Some((_, value)) = inherited_environment.iter().find(|(key, _)| key == name) {
            environment.push((OsString::from(name), value.clone()));
        }
    }
    environment.extend(
        backup_connection_env(database_url)?
            .into_iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value))),
    );
    Ok(environment)
}

fn finish_backup(
    partial: &Path,
    final_path: &Path,
) -> Result<MigrationRecoveryPointReceipt, &'static str> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(partial)
        .map_err(|_| "backup_read_failed")?;
    let size = file.metadata().map_err(|_| "backup_read_failed")?.len();
    if size == 0 || size > MAX_BACKUP {
        drop(file);
        fs::remove_file(partial).map_err(|_| "backup_partial_cleanup_failed")?;
        return Err("backup_size_invalid");
    }
    file.sync_all().map_err(|_| "backup_sync_failed")?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let length = file.read(&mut buffer).map_err(|_| "backup_read_failed")?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    // Validate the private file before publishing a recovery point. A successful
    // pg_dump exit alone does not prove that its output can recover the journal.
    // Close our handle before exact-file cleanup, including on Windows.
    drop(file);
    let receipt = MigrationRecoveryPointReceipt {
        path: partial.to_path_buf(),
        size_bytes: size,
        sha256: format!("{:x}", digest.finalize()),
        includes_migration_journal: true,
    };
    if crate::apply::validate_recovery_point(&receipt).is_err() {
        fs::remove_file(partial).map_err(|_| "backup_partial_cleanup_failed")?;
        return Err("recovery_point_invalid");
    }
    // Hard-link publication fails if the destination exists, unlike rename on
    // Unix. Both names live in the same recovery directory/filesystem.
    fs::hard_link(partial, final_path).map_err(|_| "backup_publish_failed")?;
    fs::remove_file(partial).map_err(|_| "backup_publish_failed")?;
    #[cfg(unix)]
    File::open(final_path.parent().ok_or("backup_directory_failed")?)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "backup_sync_failed")?;
    Ok(MigrationRecoveryPointReceipt {
        path: final_path.to_path_buf(),
        ..receipt
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rudder_migration_core::{MigrationLimits, load_migration_manifest};

    struct UnexpectedBackupJournalReader;

    impl BackupJournalReader for UnexpectedBackupJournalReader {
        fn lookup<'a>(
            &'a self,
            _connection: &'a mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        ) -> BackupJournalLookupFuture<'a> {
            panic!("cancelled backup lookup must not issue SQL")
        }
    }

    #[tokio::test]
    async fn cancellation_before_backup_lookup_sql_is_operation_aborted() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgresql://postgres:postgres@localhost/rudder")
            .unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let result = lookup_backup_journal_schema_with_reader(
            &pool,
            &pool,
            &cancellation,
            &UnexpectedBackupJournalReader,
        )
        .await;

        assert_eq!(result, Err("operation_aborted"));
        pool.close().await;
    }

    #[tokio::test]
    async fn cancellation_after_database_connect_io_starts_is_unconfirmed() {
        let cancellation = CancellationToken::new();
        let operation_cancellation = cancellation.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let operation = async move {
            let _ = started_tx.send(());
            std::future::pending::<Result<(), sqlx::Error>>().await
        };
        let connect = tokio::spawn(async move {
            await_cancellable_database_io(
                &operation_cancellation,
                operation,
                "database_connect_failed",
            )
            .await
        });

        started_rx
            .await
            .expect("database I/O future was not polled");
        cancellation.cancel();
        assert_eq!(
            connect.await.unwrap(),
            Err("cancellation_cleanup_unconfirmed")
        );
    }

    #[tokio::test]
    async fn cancellation_before_database_connect_remains_operation_aborted() {
        let temp = tempfile::tempdir().unwrap();
        let migrations = temp.path().join("migrations");
        fs::create_dir_all(migrations.join("meta")).unwrap();
        fs::write(migrations.join("0000_test.sql"), "SELECT 1;\\n").unwrap();
        fs::write(
            migrations.join("meta/_journal.json"),
            r#"{"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1000,"tag":"0000_test","breakpoints":true}]}"#,
        )
        .unwrap();
        let manifest = load_migration_manifest(
            &migrations.join("meta/_journal.json"),
            &migrations,
            MigrationLimits::default(),
        )
        .unwrap();
        let input = serde_json::json!({
            "schema": SCHEMA,
            "protocolVersion": 1,
            "allowApply": true,
            "migrationsDir": migrations,
            "expectedFingerprint": manifest.fingerprint,
            "recoveryDirectory": temp.path().join("recovery"),
            "pgDumpBinary": temp.path().join("pg_dump"),
        });
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            apply_operator_cancellable(
                input.to_string().as_bytes(),
                "not-a-database-url",
                cancellation,
            )
            .await,
            Err("operation_aborted")
        );
    }

    #[test]
    fn backup_connection_uses_parsed_environment_and_query_overrides() {
        let values: std::collections::HashMap<_, _> = backup_connection_env(
            "postgresql://alice:p%40ss@localhost:5555/old?dbname=fixture&password=new%20pass&sslmode=require"
        ).unwrap().into_iter().collect();
        assert_eq!(values["PGDATABASE"], "fixture");
        assert_eq!(values["PGPASSWORD"], "new pass");
        assert_eq!(values["PGPORT"], "5555");
        assert_eq!(values["PGSSLMODE"], "require");
    }
    #[test]
    fn explicit_apply_and_pinned_source_are_required() {
        let temp = tempfile::tempdir().unwrap();
        let valid = serde_json::json!({"schema":SCHEMA,"protocolVersion":1,"allowApply":true,"migrationsDir":temp.path().join("migrations"),"expectedFingerprint":"a".repeat(64),"recoveryDirectory":temp.path().join("recovery"),"pgDumpBinary":temp.path().join("pg_dump")});
        assert!(parse(valid.to_string().as_bytes()).is_ok());
        for (field, value) in [
            ("allowApply", serde_json::json!(false)),
            ("expectedFingerprint", serde_json::json!("")),
            ("migrationsDir", serde_json::json!("/tmp/../data")),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(parse(invalid.to_string().as_bytes()).is_err());
        }
    }
    #[test]
    fn startup_gate_accepts_only_a_state_bound_prompt_decision() {
        let temp = tempfile::tempdir().unwrap();
        let valid = serde_json::json!({
            "schema":SCHEMA,
            "protocolVersion":1,
            "allowApply":true,
            "migrationsDir":temp.path().join("migrations"),
            "expectedFingerprint":"a".repeat(64),
            "recoveryDirectory":temp.path().join("recovery"),
            "pgDumpBinary":temp.path().join("pg_dump"),
            "startupGate":{"policy":"prompt"}
        });
        assert!(parse(valid.to_string().as_bytes()).is_ok());

        let mut facts_request = valid.clone();
        facts_request["startupGate"] = serde_json::json!({"facts":{
            "autoApplyRequested":false,
            "promptNever":false,
            "interactive":true,
            "embeddedClusterInitializedBeforeStartup":false,
            "applicationDatabaseCreated":true
        }});
        let parsed_facts = parse(facts_request.to_string().as_bytes()).unwrap();
        let facts_gate = parsed_facts.startup_gate.unwrap();
        assert_eq!(
            facts_gate.effective_policy(),
            Some(StartupMigrationPolicy::Prompt)
        );
        assert_eq!(
            facts_gate.facts.unwrap().application_database_created,
            Some(true)
        );
        let mut facts_approved = facts_request.clone();
        facts_approved["startupGate"]["approval"] = serde_json::json!({
            "stateToken":"b".repeat(64),
            "approved":true
        });
        assert!(parse(facts_approved.to_string().as_bytes()).is_ok());

        for (auto_apply_requested, prompt_never, interactive, expected) in [
            (true, true, true, StartupMigrationPolicy::Automatic),
            (false, true, false, StartupMigrationPolicy::Never),
            (false, false, false, StartupMigrationPolicy::Automatic),
            (false, false, true, StartupMigrationPolicy::Prompt),
        ] {
            let gate: StartupGateRequest = serde_json::from_value(serde_json::json!({
                "facts": { "autoApplyRequested": auto_apply_requested, "promptNever": prompt_never, "interactive": interactive }
            }))
            .unwrap();
            assert_eq!(gate.effective_policy(), Some(expected));
        }

        let mut approved = valid.clone();
        approved["startupGate"]["approval"] = serde_json::json!({
            "stateToken":"b".repeat(64),
            "approved":true
        });
        assert!(parse(approved.to_string().as_bytes()).is_ok());

        for invalid_gate in [
            serde_json::json!({"policy":"automatic","approval":{"stateToken":"b".repeat(64),"approved":true}}),
            serde_json::json!({"policy":"prompt","approval":{"stateToken":"bad","approved":true}}),
            serde_json::json!({"policy":"never","approval":{"stateToken":"b".repeat(64),"approved":false}}),
            serde_json::json!({"policy":"prompt","facts":{"autoApplyRequested":false,"promptNever":false,"interactive":true}}),
            serde_json::json!({"facts":{"autoApplyRequested":true,"promptNever":false,"interactive":true},"approval":{"stateToken":"b".repeat(64),"approved":true}}),
        ] {
            let mut invalid = valid.clone();
            invalid["startupGate"] = invalid_gate;
            assert!(parse(invalid.to_string().as_bytes()).is_err());
        }
    }
    #[test]
    fn fresh_bootstrap_auto_apply_requires_empty_rust_preflight_and_lifecycle_facts() {
        let gate: StartupGateRequest = serde_json::from_value(serde_json::json!({
            "facts": {
                "autoApplyRequested": false,
                "promptNever": false,
                "interactive": true,
                "embeddedClusterInitializedBeforeStartup": false,
                "applicationDatabaseCreated": false
            }
        }))
        .unwrap();
        let bootstrap = MigrationPreflightReport {
            status: MigrationPreflightStatus::Bootstrap,
            table_count: 0,
            journal_present: false,
            journal_schema: None,
            core_schema_present: false,
            organizations_table_present: false,
            history: rudder_migration_history_core::MigrationHistoryPreflight {
                status: rudder_migration_history_core::MigrationHistoryStatus::NeedsMigrations,
                reason:
                    rudder_migration_history_core::MigrationHistoryReason::MigrationJournalMissing,
                manifest_fingerprint: "a".repeat(64),
                migration_table_schema: None,
                journal_entry_count: 0,
                applied_migrations: Vec::new(),
                pending_migrations: Vec::new(),
                diagnostics: Vec::new(),
                catalog_repair_candidates: Vec::new(),
            },
            diagnostics: Vec::new(),
            pending_legacy_column_renames: Vec::new(),
            legacy_column_conflicts: Vec::new(),
        };
        assert!(gate.should_auto_apply_fresh_bootstrap(&bootstrap));

        let mut database_created = gate.clone();
        database_created
            .facts
            .as_mut()
            .unwrap()
            .embedded_cluster_initialized_before_startup = Some(true);
        database_created
            .facts
            .as_mut()
            .unwrap()
            .application_database_created = Some(true);
        assert!(database_created.should_auto_apply_fresh_bootstrap(&bootstrap));

        let mut nonempty = bootstrap.clone();
        nonempty.table_count = 1;
        nonempty.status = MigrationPreflightStatus::UnsafeLegacy;
        assert!(!gate.should_auto_apply_fresh_bootstrap(&nonempty));

        let mut stale_lifecycle = gate.clone();
        stale_lifecycle
            .facts
            .as_mut()
            .unwrap()
            .embedded_cluster_initialized_before_startup = Some(true);
        assert!(!stale_lifecycle.should_auto_apply_fresh_bootstrap(&bootstrap));

        let mut never = gate;
        never.facts.as_mut().unwrap().prompt_never = true;
        assert!(!never.should_auto_apply_fresh_bootstrap(&bootstrap));
    }

    #[test]
    fn startup_approval_token_is_bound_to_configured_database_target() {
        let report = MigrationPreflightReport {
            status: MigrationPreflightStatus::Bootstrap,
            table_count: 0,
            journal_present: false,
            journal_schema: None,
            core_schema_present: false,
            organizations_table_present: false,
            history: rudder_migration_history_core::MigrationHistoryPreflight {
                status: rudder_migration_history_core::MigrationHistoryStatus::NeedsMigrations,
                reason:
                    rudder_migration_history_core::MigrationHistoryReason::MigrationJournalMissing,
                manifest_fingerprint: "a".repeat(64),
                migration_table_schema: None,
                journal_entry_count: 0,
                applied_migrations: Vec::new(),
                pending_migrations: Vec::new(),
                diagnostics: Vec::new(),
                catalog_repair_candidates: Vec::new(),
            },
            diagnostics: Vec::new(),
            pending_legacy_column_renames: Vec::new(),
            legacy_column_conflicts: Vec::new(),
        };
        let token = startup_approval_token("postgresql://user:secret@localhost/first", &report);
        let other_target =
            startup_approval_token("postgresql://user:secret@localhost/second", &report);
        assert_ne!(token, other_target);
    }
    fn complete_operator_dump() -> &'static str {
        "-- Rudder database backup\n-- PostgreSQL database dump\nCREATE TABLE drizzle.__drizzle_migrations (id integer, hash text, created_at bigint);\nCOPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;\n1\tabc\t1000\n\\.\n-- PostgreSQL database dump complete\n"
    }

    #[test]
    fn recovery_publication_requires_valid_dump_and_preserves_neighbor() {
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("backup.partial");
        let target = temp.path().join("backup.sql");
        let neighbor = temp.path().join("existing.sql");
        fs::write(&neighbor, "preserved recovery data").unwrap();
        fs::write(&partial, "").unwrap();
        assert_eq!(
            finish_backup(&partial, &target).unwrap_err(),
            "backup_size_invalid"
        );
        assert!(!partial.exists());
        assert!(!target.exists());
        let valid = complete_operator_dump();
        let invalid = [
            "-- Rudder database backup\n",
            valid.split("\\.\n").next().unwrap(),
            "-- Rudder database backup\n-- PostgreSQL database dump\nCREATE TABLE public.unrelated (id integer);\nCOPY public.unrelated (id) FROM stdin;\n1\n\\.\n-- PostgreSQL database dump complete\n",
        ];
        for content in invalid {
            fs::write(&partial, content).unwrap();
            assert_eq!(
                finish_backup(&partial, &target).unwrap_err(),
                "recovery_point_invalid"
            );
            assert!(!partial.exists());
            assert!(!target.exists());
            assert_eq!(fs::read(&neighbor).unwrap(), b"preserved recovery data");
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        }
        fs::write(&partial, valid).unwrap();
        let receipt = finish_backup(&partial, &target).unwrap();
        assert_eq!(receipt.path, target);
        assert!(!partial.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), valid);
        assert!(crate::apply::validate_recovery_point(&receipt).is_ok());
    }

    #[test]
    fn recovery_publication_never_overwrites_existing_backup() {
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("backup.partial");
        let target = temp.path().join("backup.sql");
        fs::write(&partial, complete_operator_dump()).unwrap();
        fs::write(&target, "existing backup").unwrap();
        assert!(finish_backup(&partial, &target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "existing backup");
        assert!(partial.exists());
    }

    #[tokio::test]
    async fn missing_pg_dump_removes_only_its_own_partial_backup() {
        let temp = tempfile::tempdir().unwrap();
        let recovery = temp.path().join("recovery");
        fs::create_dir(&recovery).unwrap();
        let existing = recovery.join("existing.sql.partial");
        fs::write(&existing, "preserved recovery data").unwrap();

        let result = create_backup_with_environment(
            &recovery,
            &temp.path().join("missing-pg-dump"),
            "postgresql://fixture:fixture@localhost/rudder",
            &[],
        )
        .await;

        assert_eq!(result.unwrap_err(), "backup_process_failed");
        assert_eq!(
            fs::read_to_string(&existing).unwrap(),
            "preserved recovery data"
        );
        assert_eq!(fs::read_dir(&recovery).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_pg_dump_removes_only_its_own_partial_backup() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("pg-dump-failure");
        fs::write(&binary, "#!/bin/sh\nprintf 'incomplete dump\\n'\nexit 7\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let recovery = temp.path().join("recovery");
        fs::create_dir(&recovery).unwrap();
        let existing = recovery.join("existing.sql");
        fs::write(&existing, "preserved recovery data").unwrap();

        let result = create_backup_with_environment(
            &recovery,
            &binary,
            "postgresql://fixture:fixture@localhost/rudder",
            &[],
        )
        .await;

        assert_eq!(result.unwrap_err(), "backup_process_failed");
        assert_eq!(
            fs::read_to_string(&existing).unwrap(),
            "preserved recovery data"
        );
        assert_eq!(fs::read_dir(&recovery).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pg_dump_child_receives_allowlisted_environment_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("pg_dump");
        fs::write(
            &binary,
            format!(
                "{}cat <<'RUDDER_DUMP'\n{}RUDDER_DUMP\n",
                "#!/bin/sh\nprintf 'APP_SECRET=%s\\nCUSTOM_SECRET=%s\\nPGHOST=%s\\nPGPASSWORD=%s\\nPGPORT=%s\\nPATH=%s\\n' \"${RUDDER_APP_SECRET-unset}\" \"${CUSTOM_SECRET-unset}\" \"${PGHOST-unset}\" \"${PGPASSWORD-unset}\" \"${PGPORT-unset}\" \"${PATH-unset}\"\n",
                complete_operator_dump(),
            ),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let inherited_environment = [
            (OsString::from("PATH"), OsString::from("/bin")),
            (OsString::from("HOME"), temp.path().as_os_str().to_owned()),
            (
                OsString::from("RUDDER_APP_SECRET"),
                OsString::from("application-secret-sentinel"),
            ),
            (
                OsString::from("CUSTOM_SECRET"),
                OsString::from("custom-secret-sentinel"),
            ),
            (OsString::from("PGHOST"), OsString::from("ambient-host")),
            (
                OsString::from("PGPASSWORD"),
                OsString::from("ambient-password-sentinel"),
            ),
        ];
        let receipt = create_backup_with_environment(
            &temp.path().join("recovery"),
            &binary,
            "postgresql://alice:database-password-sentinel@db.example:5555/rudder?sslmode=require",
            &inherited_environment,
        )
        .await
        .unwrap();
        let output = fs::read_to_string(receipt.path).unwrap();

        assert!(output.contains("APP_SECRET=unset"));
        assert!(output.contains("CUSTOM_SECRET=unset"));
        assert!(output.contains("PGHOST=db.example"));
        assert!(output.contains("PGPASSWORD=database-password-sentinel"));
        assert!(output.contains("PGPORT=5555"));
        assert!(output.contains("PATH=/bin"));
        assert!(!output.contains("application-secret-sentinel"));
        assert!(!output.contains("custom-secret-sentinel"));
        assert!(!output.contains("ambient-host"));
        assert!(!output.contains("ambient-password-sentinel"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_backup_kills_pg_dump_process_group_and_grandchild() {
        use std::{os::unix::fs::PermissionsExt, process::Command as StdCommand};

        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("pg_dump-with-child");
        let dump_pid_file = temp.path().join("pg_dump.pid");
        let child_pid_file = temp.path().join("pg_dump-child.pid");
        let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > {}\nsleep 60 &\nchild=$!\nprintf '%s\\n' \"$child\" > {}\nwait \"$child\"\n",
                quote(&dump_pid_file),
                quote(&child_pid_file),
            ),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();

        let recovery = temp.path().join("recovery");
        let inherited_environment = [(OsString::from("PATH"), OsString::from("/bin"))];
        let task = tokio::spawn({
            let binary = binary.clone();
            let recovery = recovery.clone();
            async move {
                create_backup_with_environment(
                    &recovery,
                    &binary,
                    "postgresql://alice:fixture@localhost/rudder",
                    &inherited_environment,
                )
                .await
            }
        });

        let started = tokio::time::Instant::now();
        while !dump_pid_file.is_file() || !child_pid_file.is_file() {
            if started.elapsed() > Duration::from_secs(10) {
                task.abort();
                let _ = task.await;
                panic!("backup fixture did not start its process tree");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let dump_pid = fs::read_to_string(&dump_pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let child_pid = fs::read_to_string(&child_pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();

        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        for (pid, label) in [(dump_pid, "pg_dump stub"), (child_pid, "pg_dump child")] {
            let started = std::time::Instant::now();
            loop {
                let output = StdCommand::new("ps")
                    .args(["-o", "stat=", "-p", &pid.to_string()])
                    .output()
                    .unwrap();
                let state = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if state.is_empty() || state.starts_with('Z') {
                    break;
                }
                if started.elapsed() > Duration::from_secs(5) {
                    unsafe {
                        libc::kill(-(dump_pid as i32), libc::SIGKILL);
                        libc::kill(dump_pid as i32, libc::SIGKILL);
                        libc::kill(child_pid as i32, libc::SIGKILL);
                    }
                    panic!("{label} remained alive after backup cancellation (state {state})");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}
