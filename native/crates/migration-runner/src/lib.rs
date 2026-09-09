//! Explicit, fail-closed SQLx migration execution.
//!
//! This crate is an API/CLI boundary only. It does not run during server
//! startup and it does not claim migration ownership from the current Node
//! implementation. Callers must explicitly load a candidate and optional
//! immutable baseline, provide recovery evidence when a non-empty database
//! will be changed, and then invoke [`MigrationRunner::run`].

use async_trait::async_trait;
use rudder_migration_core::{
    AdvisoryLockRequirement, MIGRATION_ADVISORY_LOCK_NAME, MigrationEntry, MigrationManifest,
    MigrationManifestOptions, PreMutationRequirements, RecoveryPointRequirement,
    load_migration_manifest_with_options, validate_migration_manifest_compatibility,
    validate_pre_mutation_requirements,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, pool::PoolConnection};
use std::collections::{BTreeSet, HashMap};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error as ThisError;
use tokio::time::{Instant, sleep};

pub const RUNNER_PROTOCOL_VERSION: u16 = 1;
const STATEMENT_BREAKPOINT: &str = "--> statement-breakpoint";
const DEFAULT_MAX_STATEMENT_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_MAX_STATEMENTS_PER_FILE: usize = 4_096;
const DEFAULT_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(25);

const KNOWN_LEGACY_HISTORY_IDENTIFIERS: [&str; 11] = [
    "e21cac193575f50627e67946ef9afa44ddd17af24627c8799c5024ce534f89e3",
    "fdf8b69236a60593c52be53ebff89d7f581ddbdbde0227081b11c53b1f6d6578",
    "fba251275287250b3f05a5533e00d3941a3b1c1a526d0073e5d636a2dd868f80",
    "a1fc0446af5ec1640890bb9cf36208eab8dce6687c233029bd54e179613e1af7",
    "31ba03166f91d84423463bf986219371786078bde80241379cab83d53a4df6d5",
    "e5c12f75cba0ee38da04e5175c762a4b3b5e9e9c523ea97f9956448b44e11570",
    "f48a179c17c3ae9b2b419a3f8d4ee8d78de6e4acec3a077fe0d4bcb9a73d57c6",
    "a531d1d8383becb9090492d1b763aeb11a4c2ade4f325a29500511900b29888d",
    "cbf2988159818d54929cda6119f3ca3b6cd6d265c08fb73c6221198ff99d070e",
    "legacy-0100-hash",
    "legacy-conflicting-0100-hash",
];

/// A bounded migration source. The journal and SQL directory are loaded before
/// the database lock is acquired; no database mutation happens during loading.
#[derive(Clone, Debug)]
pub struct MigrationSource {
    pub journal_path: PathBuf,
    pub migrations_dir: PathBuf,
    pub options: MigrationManifestOptions,
    pub expected_fingerprint: Option<String>,
}

impl MigrationSource {
    pub fn new(
        journal_path: impl Into<PathBuf>,
        migrations_dir: impl Into<PathBuf>,
        options: MigrationManifestOptions,
    ) -> Self {
        Self {
            journal_path: journal_path.into(),
            migrations_dir: migrations_dir.into(),
            options,
            expected_fingerprint: None,
        }
    }

    pub fn with_expected_fingerprint(mut self, fingerprint: impl Into<String>) -> Self {
        self.expected_fingerprint = Some(fingerprint.into());
        self
    }

    pub fn load(&self) -> Result<LoadedMigrationSource, MigrationSourceError> {
        let manifest = load_migration_manifest_with_options(
            &self.journal_path,
            &self.migrations_dir,
            self.options.clone(),
        )
        .map_err(|error| MigrationSourceError::new(error.code(), error.to_string()))?;
        let integrity = manifest.validate_integrity();
        if !integrity.valid {
            return Err(MigrationSourceError::new(
                "migration_manifest_invalid",
                integrity.errors.join("; "),
            ));
        }
        if let Some(expected) = &self.expected_fingerprint
            && expected != &manifest.fingerprint
        {
            return Err(MigrationSourceError::new(
                "migration_fingerprint_mismatch",
                format!(
                    "expected candidate fingerprint {expected}, loaded {}",
                    manifest.fingerprint
                ),
            ));
        }

        let mut prepared = HashMap::new();
        for entry in manifest
            .entries
            .iter()
            .filter(|entry| entry.journal_entry.is_some())
        {
            let path = self.migrations_dir.join(&entry.file_name);
            let bytes = read_bounded_sql_file(&path, self.options.limits.max_sql_file_bytes)
                .map_err(|error| MigrationSourceError::new(error.0, error.1))?;
            let actual_hash = sha256_hex(&bytes);
            if actual_hash != entry.sha256 {
                return Err(MigrationSourceError::new(
                    "migration_sql_changed",
                    format!("{} changed after manifest loading", entry.file_name),
                ));
            }
            let content = String::from_utf8(bytes).map_err(|_| {
                MigrationSourceError::new(
                    "migration_sql_invalid_utf8",
                    format!("{} is not UTF-8", entry.file_name),
                )
            })?;
            let statements = split_migration_statements(&content);
            prepared.insert(entry.file_name.clone(), statements);
        }

        Ok(LoadedMigrationSource {
            manifest,
            migrations_dir: self.migrations_dir.clone(),
            prepared,
        })
    }
}

/// A fully loaded candidate or baseline. SQL is retained as bounded statement
/// chunks so the runner does not reread mutable files after the lock boundary.
#[derive(Clone, Debug)]
pub struct LoadedMigrationSource {
    pub manifest: MigrationManifest,
    pub migrations_dir: PathBuf,
    prepared: HashMap<String, Vec<String>>,
}

impl LoadedMigrationSource {
    fn statements(&self, file_name: &str) -> Option<&[String]> {
        self.prepared.get(file_name).map(Vec::as_slice)
    }
}

#[derive(Debug, ThisError)]
#[error("{code}: {message}")]
pub struct MigrationSourceError {
    code: &'static str,
    message: String,
}

impl MigrationSourceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

/// Explicit invocation input. `baseline` is an immutable manifest from the
/// last published release, not a startup-owned or automatically discovered
/// authority.
#[derive(Clone, Debug)]
pub struct MigrationRunRequest {
    pub candidate: MigrationSource,
    pub baseline: Option<MigrationSource>,
    pub recovery: Option<RecoveryPoint>,
}

/// Evidence supplied by the caller that a restorable pre-migration recovery
/// point already exists. Creating the backup is deliberately outside this
/// low-level runner boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecoveryPoint {
    pub created: bool,
    pub includes_migration_journal: bool,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedMigration {
    pub hash: Option<String>,
    pub name: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistorySnapshot {
    pub table_exists: bool,
    pub entries: Vec<AppliedMigration>,
}

impl HistorySnapshot {
    pub fn empty() -> Self {
        Self {
            table_exists: false,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LockAcquisition {
    pub acquired: bool,
}

/// The executor seam makes ordering, recovery, and transaction behavior
/// testable without allowing tests to touch a real database. The SQLx
/// implementation below is the production adapter.
#[async_trait]
pub trait MigrationExecutor: Send {
    type Error: Error + Send + Sync + 'static;

    async fn acquire_advisory_lock(
        &mut self,
        name: &str,
        timeout: Duration,
    ) -> Result<LockAcquisition, Self::Error>;
    async fn begin(&mut self) -> Result<(), Self::Error>;
    async fn database_non_empty(&mut self) -> Result<bool, Self::Error>;
    async fn read_history(&mut self) -> Result<HistorySnapshot, Self::Error>;
    async fn ensure_history_table(&mut self) -> Result<(), Self::Error>;
    async fn execute_statement(&mut self, statement: &str) -> Result<(), Self::Error>;
    async fn record_history(&mut self, entry: &AppliedMigration) -> Result<(), Self::Error>;
    async fn check_postconditions(&mut self) -> Result<HistorySnapshot, Self::Error>;
    async fn commit(&mut self) -> Result<(), Self::Error>;
    async fn rollback(&mut self) -> Result<(), Self::Error>;
    async fn release_advisory_lock(&mut self) -> Result<(), Self::Error>;
}

#[derive(Clone, Debug)]
pub struct MigrationRunnerConfig {
    pub lock_name: String,
    pub lock_timeout: Duration,
    pub max_statement_bytes: u64,
    pub max_statements_per_file: usize,
    pub known_legacy_history_hashes: BTreeSet<String>,
}

impl Default for MigrationRunnerConfig {
    fn default() -> Self {
        Self {
            lock_name: MIGRATION_ADVISORY_LOCK_NAME.to_owned(),
            lock_timeout: Duration::from_secs(30),
            max_statement_bytes: DEFAULT_MAX_STATEMENT_BYTES,
            max_statements_per_file: DEFAULT_MAX_STATEMENTS_PER_FILE,
            known_legacy_history_hashes: KNOWN_LEGACY_HISTORY_IDENTIFIERS
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LockReceipt {
    pub name: String,
    pub acquired: bool,
    pub timed_out: bool,
    pub released: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecoveryReceipt {
    pub required: bool,
    pub provided: bool,
    pub valid: bool,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TransactionReceipt {
    pub begun: bool,
    pub committed: bool,
    pub rolled_back: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AppliedEntryReceipt {
    pub order: usize,
    pub file_name: String,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationRunStatus {
    AlreadyCurrent,
    Applied,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MigrationReceipt {
    pub protocol_version: u16,
    pub candidate_fingerprint: String,
    pub baseline_fingerprint: Option<String>,
    pub pending_entries: Vec<String>,
    pub applied_entries: Vec<AppliedEntryReceipt>,
    pub lock: LockReceipt,
    pub recovery: RecoveryReceipt,
    pub transaction: TransactionReceipt,
    pub status: MigrationRunStatus,
}

#[derive(Debug)]
pub struct MigrationRunError<E> {
    code: &'static str,
    message: String,
    receipt: Option<MigrationReceipt>,
    executor_error: Option<E>,
}

impl<E> MigrationRunError<E> {
    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn receipt(&self) -> Option<&MigrationReceipt> {
        self.receipt.as_ref()
    }

    fn without_receipt(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            receipt: None,
            executor_error: None,
        }
    }
}

impl<E: Error + 'static> Display for MigrationRunError<E> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl<E: Error + 'static> Error for MigrationRunError<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.executor_error
            .as_ref()
            .map(|error| error as &(dyn Error + 'static))
    }
}

struct RunFailure<E> {
    code: &'static str,
    message: String,
    executor_error: Option<E>,
}

impl<E> RunFailure<E> {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            executor_error: None,
        }
    }
}

impl<E: Error> RunFailure<E> {
    fn executor(error: E) -> Self {
        Self {
            code: "executor_error",
            message: error.to_string(),
            executor_error: Some(error),
        }
    }
}

impl<E: Error + 'static> RunFailure<E> {
    fn into_error(self, receipt: MigrationReceipt) -> MigrationRunError<E> {
        MigrationRunError {
            code: self.code,
            message: self.message,
            receipt: Some(receipt),
            executor_error: self.executor_error,
        }
    }
}

pub struct MigrationRunner<E> {
    executor: E,
    config: MigrationRunnerConfig,
}

impl<E> MigrationRunner<E> {
    pub fn new(executor: E, config: MigrationRunnerConfig) -> Self {
        Self { executor, config }
    }

    pub fn executor(&self) -> &E {
        &self.executor
    }

    pub fn executor_mut(&mut self) -> &mut E {
        &mut self.executor
    }

    pub fn into_executor(self) -> E {
        self.executor
    }
}

impl<E> MigrationRunner<E>
where
    E: MigrationExecutor,
{
    pub async fn run(
        &mut self,
        request: MigrationRunRequest,
    ) -> Result<MigrationReceipt, MigrationRunError<E::Error>> {
        let MigrationRunRequest {
            candidate: candidate_source,
            baseline: baseline_source,
            recovery,
        } = request;
        let candidate = candidate_source
            .load()
            .map_err(|error| MigrationRunError::without_receipt(error.code(), error.to_string()))?;
        let baseline = baseline_source
            .map(|source| source.load())
            .transpose()
            .map_err(|error: MigrationSourceError| {
                MigrationRunError::without_receipt(error.code(), error.to_string())
            })?;

        let mut receipt = MigrationReceipt {
            protocol_version: RUNNER_PROTOCOL_VERSION,
            candidate_fingerprint: candidate.manifest.fingerprint.clone(),
            baseline_fingerprint: baseline
                .as_ref()
                .map(|source| source.manifest.fingerprint.clone()),
            pending_entries: Vec::new(),
            applied_entries: Vec::new(),
            lock: LockReceipt {
                name: self.config.lock_name.clone(),
                acquired: false,
                timed_out: false,
                released: false,
            },
            recovery: RecoveryReceipt {
                required: false,
                provided: recovery.is_some(),
                valid: true,
                path: recovery.as_ref().and_then(|point| point.path.clone()),
            },
            transaction: TransactionReceipt {
                begun: false,
                committed: false,
                rolled_back: false,
            },
            status: MigrationRunStatus::AlreadyCurrent,
        };

        let lock = self
            .executor
            .acquire_advisory_lock(&self.config.lock_name, self.config.lock_timeout)
            .await
            .map_err(|error| {
                let mut failure = RunFailure::executor(error);
                failure.message = format!("failed to acquire advisory lock: {}", failure.message);
                failure.into_error(receipt.clone())
            })?;
        if !lock.acquired {
            receipt.lock.timed_out = true;
            return Err(RunFailure::<E::Error>::new(
                "lock_timeout",
                format!(
                    "advisory lock {} was not acquired before timeout",
                    self.config.lock_name
                ),
            )
            .into_error(receipt));
        }
        receipt.lock.acquired = true;

        let run_result = self
            .run_locked(
                &candidate,
                baseline.as_ref(),
                recovery.as_ref(),
                &mut receipt,
            )
            .await;

        let mut failure = run_result.err();

        if failure.is_some()
            && receipt.transaction.begun
            && !receipt.transaction.committed
            && !receipt.transaction.rolled_back
        {
            if let Err(error) = self.executor.rollback().await {
                failure = Some(RunFailure {
                    code: "transaction_rollback_failed",
                    message: format!("migration failed and rollback failed: {}", error),
                    executor_error: Some(error),
                });
            } else {
                receipt.transaction.rolled_back = true;
                receipt.applied_entries.clear();
            }
        }

        if let Err(error) = self.executor.release_advisory_lock().await {
            if let Some(existing) = &mut failure {
                existing.message = format!(
                    "{}; advisory lock release failed: {}",
                    existing.message, error
                );
            } else {
                failure = Some(RunFailure::executor(error));
            }
        } else {
            receipt.lock.released = true;
        }

        match failure {
            Some(failure) => Err(failure.into_error(receipt)),
            None => Ok(receipt),
        }
    }

    async fn run_locked(
        &mut self,
        candidate: &LoadedMigrationSource,
        baseline: Option<&LoadedMigrationSource>,
        recovery: Option<&RecoveryPoint>,
        receipt: &mut MigrationReceipt,
    ) -> Result<(), RunFailure<E::Error>> {
        self.executor.begin().await.map_err(RunFailure::executor)?;
        receipt.transaction.begun = true;

        validate_loaded_manifest(&candidate.manifest)?;
        if let Some(baseline) = baseline {
            validate_loaded_manifest(&baseline.manifest)?;
            let compatibility =
                validate_migration_manifest_compatibility(&baseline.manifest, &candidate.manifest);
            if !compatibility.valid || !compatibility.compatible {
                return Err(RunFailure::new(
                    "migration_baseline_incompatible",
                    compatibility.errors.join("; "),
                ));
            }
        }

        let history = self
            .executor
            .read_history()
            .await
            .map_err(RunFailure::executor)?;
        let database_non_empty = self
            .executor
            .database_non_empty()
            .await
            .map_err(RunFailure::executor)?;
        let plan = self.plan_history(&history, &candidate.manifest, false)?;
        receipt.pending_entries = plan
            .pending
            .iter()
            .map(|entry| entry.file_name.clone())
            .collect();

        if plan.pending.is_empty() {
            let postcondition_history = self
                .executor
                .check_postconditions()
                .await
                .map_err(RunFailure::executor)?;
            self.plan_history(&postcondition_history, &candidate.manifest, true)
                .map_err(|failure| {
                    RunFailure::new("migration_postcondition_failed", failure.message)
                })?;
            self.executor.commit().await.map_err(RunFailure::executor)?;
            receipt.transaction.committed = true;
            receipt.status = MigrationRunStatus::AlreadyCurrent;
            return Ok(());
        }

        let recovery_valid = recovery.is_some_and(|point| {
            point.created
                && point.includes_migration_journal
                && point.path.as_deref().is_some_and(|path| !path.is_empty())
        });
        receipt.recovery.required = database_non_empty;
        receipt.recovery.valid = !database_non_empty || recovery_valid;
        let pre_mutation = validate_pre_mutation_requirements(&PreMutationRequirements {
            version: rudder_migration_core::PRE_MUTATION_REQUIREMENTS_VERSION,
            database_non_empty,
            mutation_requested: true,
            lock: AdvisoryLockRequirement {
                name: self.config.lock_name.clone(),
                acquired: true,
            },
            recovery: RecoveryPointRequirement {
                required: database_non_empty,
                created: recovery.is_some_and(|point| point.created),
                includes_migration_journal: recovery
                    .is_some_and(|point| point.includes_migration_journal),
                path: recovery.and_then(|point| point.path.clone()),
            },
        });
        if !pre_mutation.valid {
            return Err(RunFailure::new(
                "recovery_required",
                pre_mutation.errors.join("; "),
            ));
        }

        self.executor
            .ensure_history_table()
            .await
            .map_err(RunFailure::executor)?;

        let mut applied_receipts = Vec::with_capacity(plan.pending.len());
        for entry in &plan.pending {
            let statements = candidate.statements(&entry.file_name).ok_or_else(|| {
                RunFailure::new(
                    "migration_sql_missing",
                    format!("prepared SQL is missing for {}", entry.file_name),
                )
            })?;
            if statements.len() > self.config.max_statements_per_file {
                return Err(RunFailure::new(
                    "migration_statement_count_limit",
                    format!("{} has too many statements", entry.file_name),
                ));
            }
            for statement in statements {
                if statement.len() as u64 > self.config.max_statement_bytes {
                    return Err(RunFailure::new(
                        "migration_statement_size_limit",
                        format!(
                            "statement in {} exceeds the configured bound",
                            entry.file_name
                        ),
                    ));
                }
                self.executor
                    .execute_statement(statement)
                    .await
                    .map_err(RunFailure::executor)?;
            }
            let journal_entry = entry.journal_entry.as_ref().ok_or_else(|| {
                RunFailure::new(
                    "migration_sql_unknown",
                    format!(
                        "legacy unjournaled file {} cannot be applied",
                        entry.file_name
                    ),
                )
            })?;
            let created_at = i64::try_from(journal_entry.when).map_err(|_| {
                RunFailure::new(
                    "migration_timestamp_overflow",
                    format!(
                        "{} has a timestamp outside PostgreSQL bigint range",
                        entry.file_name
                    ),
                )
            })?;
            self.executor
                .record_history(&AppliedMigration {
                    hash: Some(entry.sha256.clone()),
                    name: Some(entry.file_name.clone()),
                    created_at: Some(created_at),
                })
                .await
                .map_err(RunFailure::executor)?;
            applied_receipts.push(AppliedEntryReceipt {
                order: entry.order,
                file_name: entry.file_name.clone(),
                sha256: entry.sha256.clone(),
                byte_size: entry.byte_size,
            });
        }

        let postcondition_history = self
            .executor
            .check_postconditions()
            .await
            .map_err(RunFailure::executor)?;
        self.plan_history(&postcondition_history, &candidate.manifest, true)
            .map_err(|failure| {
                RunFailure::new("migration_postcondition_failed", failure.message)
            })?;

        self.executor.commit().await.map_err(RunFailure::executor)?;
        receipt.transaction.committed = true;
        receipt.applied_entries = applied_receipts;
        receipt.status = MigrationRunStatus::Applied;
        Ok(())
    }

    fn plan_history(
        &self,
        history: &HistorySnapshot,
        manifest: &MigrationManifest,
        require_complete: bool,
    ) -> Result<HistoryPlan, RunFailure<E::Error>> {
        let journal_entries = manifest
            .entries
            .iter()
            .filter(|entry| entry.journal_entry.is_some())
            .collect::<Vec<_>>();
        if !history.table_exists && !history.entries.is_empty() {
            return Err(RunFailure::new(
                "migration_history_dirty",
                "migration history has rows but no recognized journal table",
            ));
        }

        let mut cursor = 0_usize;
        let mut seen_legacy = BTreeSet::new();
        for row in &history.entries {
            let by_hash = row
                .hash
                .as_deref()
                .and_then(|hash| manifest.entries.iter().find(|entry| entry.sha256 == hash));
            let by_name = row.name.as_deref().and_then(|name| {
                manifest
                    .entries
                    .iter()
                    .find(|entry| entry.file_name == name)
            });
            let known_legacy_hash = row
                .hash
                .as_deref()
                .is_some_and(|hash| self.config.known_legacy_history_hashes.contains(hash));

            if row.hash.is_some() && by_hash.is_none() {
                if !known_legacy_hash {
                    return Err(RunFailure::new(
                        "migration_history_unknown",
                        format!(
                            "history hash {} is not present in the candidate manifest",
                            row.hash.as_deref().unwrap_or("<empty>")
                        ),
                    ));
                }
                if by_name.is_some_and(|entry| !entry.is_legacy_unjournaled()) {
                    return Err(RunFailure::new(
                        "migration_history_dirty",
                        "known legacy history hash conflicts with a journaled migration name",
                    ));
                }
            }

            if let (Some(hash_entry), Some(name_entry)) = (by_hash, by_name) {
                if hash_entry.file_name != name_entry.file_name {
                    return Err(RunFailure::new(
                        "migration_history_dirty",
                        format!("history name/hash mismatch for {}", name_entry.file_name),
                    ));
                }
            } else if row.name.is_some() && by_name.is_none() {
                return Err(RunFailure::new(
                    "migration_history_unknown",
                    format!(
                        "history migration name {} is not present in the candidate manifest",
                        row.name.as_deref().unwrap_or("<empty>")
                    ),
                ));
            }

            let matched = by_hash.or(by_name);
            let Some(entry) = matched else {
                if known_legacy_hash {
                    let identifier = row
                        .hash
                        .clone()
                        .unwrap_or_else(|| row.name.clone().unwrap_or_default());
                    if !seen_legacy.insert(identifier) {
                        return Err(RunFailure::new(
                            "migration_history_dirty",
                            "migration history repeats a legacy identifier",
                        ));
                    }
                    continue;
                }
                return Err(RunFailure::new(
                    "migration_history_unknown",
                    format!(
                        "history entry {} is not present in the candidate manifest",
                        row.name
                            .as_deref()
                            .or(row.hash.as_deref())
                            .unwrap_or("<empty>")
                    ),
                ));
            };

            if entry.is_legacy_unjournaled() {
                let identifier = row
                    .hash
                    .clone()
                    .or_else(|| Some(entry.file_name.clone()))
                    .unwrap_or_default();
                if !seen_legacy.insert(identifier) {
                    return Err(RunFailure::new(
                        "migration_history_dirty",
                        format!("migration history repeats {}", entry.file_name),
                    ));
                }
                continue;
            }

            let Some(expected) = journal_entries.get(cursor) else {
                return Err(RunFailure::new(
                    "migration_history_dirty",
                    format!(
                        "migration history contains an extra entry at {}",
                        entry.file_name
                    ),
                ));
            };
            if entry.order != expected.order {
                return Err(RunFailure::new(
                    "migration_history_dirty",
                    format!("migration history is reordered at {}", entry.file_name),
                ));
            }
            cursor += 1;
        }

        if require_complete && cursor != journal_entries.len() {
            return Err(RunFailure::new(
                "migration_postcondition_failed",
                format!(
                    "migration history has {cursor} journal entries; expected {}",
                    journal_entries.len()
                ),
            ));
        }

        Ok(HistoryPlan {
            pending: journal_entries[cursor..]
                .iter()
                .map(|entry| (*entry).clone())
                .collect(),
        })
    }
}

struct HistoryPlan {
    pending: Vec<MigrationEntry>,
}

fn validate_loaded_manifest<E>(manifest: &MigrationManifest) -> Result<(), RunFailure<E>> {
    let integrity = manifest.validate_integrity();
    if integrity.valid {
        Ok(())
    } else {
        Err(RunFailure::new(
            "migration_manifest_invalid",
            integrity.errors.join("; "),
        ))
    }
}

/// Split the Drizzle statement-breakpoint format without attempting to parse
/// SQL. A breakpoint is the only statement boundary the generated migration
/// format promises to the runner.
pub fn split_migration_statements(content: &str) -> Vec<String> {
    content
        .split(STATEMENT_BREAKPOINT)
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn read_bounded_sql_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, (&'static str, String)> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| ("migration_file_missing", error.to_string()))?;
    if !metadata.file_type().is_file() {
        return Err(("migration_file_not_regular", path.display().to_string()));
    }
    if metadata.len() > max_bytes {
        return Err(("migration_sql_size_limit", path.display().to_string()));
    }
    let bytes = fs::read(path).map_err(|error| ("migration_file_unreadable", error.to_string()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(("migration_sql_size_limit", path.display().to_string()));
    }
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, ThisError)]
pub enum SqlxMigrationExecutorError {
    #[error("SQLx database operation failed: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration executor is not holding its PostgreSQL connection")]
    ConnectionMissing,
    #[error("migration executor operation requires an open transaction")]
    TransactionMissing,
    #[error("invalid PostgreSQL identifier {0}")]
    InvalidIdentifier(String),
    #[error("migration history table is missing required columns")]
    InvalidHistoryTable,
    #[error("migration history created_at overflow")]
    CreatedAtOverflow,
}

#[derive(Clone, Debug)]
pub struct SqlxMigrationExecutorConfig {
    pub history_schema: String,
    pub history_table: String,
    pub search_path: Vec<String>,
    pub lock_poll_interval: Duration,
}

impl Default for SqlxMigrationExecutorConfig {
    fn default() -> Self {
        Self {
            history_schema: "drizzle".to_owned(),
            history_table: "__drizzle_migrations".to_owned(),
            search_path: Vec::new(),
            lock_poll_interval: DEFAULT_LOCK_POLL_INTERVAL,
        }
    }
}

pub struct SqlxMigrationExecutor {
    pool: PgPool,
    config: SqlxMigrationExecutorConfig,
    connection: Option<PoolConnection<Postgres>>,
    lock_held: bool,
    held_lock_name: Option<String>,
    transaction_open: bool,
    resolved_history_schema: Option<String>,
}

impl SqlxMigrationExecutor {
    pub fn new(pool: PgPool) -> Result<Self, SqlxMigrationExecutorError> {
        Self::with_config(pool, SqlxMigrationExecutorConfig::default())
    }

    pub fn with_config(
        pool: PgPool,
        config: SqlxMigrationExecutorConfig,
    ) -> Result<Self, SqlxMigrationExecutorError> {
        validate_identifier(&config.history_schema)?;
        validate_identifier(&config.history_table)?;
        for schema in &config.search_path {
            validate_identifier(schema)?;
        }
        Ok(Self {
            pool,
            config,
            connection: None,
            lock_held: false,
            held_lock_name: None,
            transaction_open: false,
            resolved_history_schema: None,
        })
    }

    fn connection_mut(
        &mut self,
    ) -> Result<&mut PoolConnection<Postgres>, SqlxMigrationExecutorError> {
        self.connection
            .as_mut()
            .ok_or(SqlxMigrationExecutorError::ConnectionMissing)
    }

    fn require_transaction(&self) -> Result<(), SqlxMigrationExecutorError> {
        if self.transaction_open {
            Ok(())
        } else {
            Err(SqlxMigrationExecutorError::TransactionMissing)
        }
    }

    fn history_schema(&self) -> &str {
        self.resolved_history_schema
            .as_deref()
            .unwrap_or(&self.config.history_schema)
    }

    fn qualified_history_table(&self) -> String {
        format!(
            "{}.{}",
            quote_identifier(self.history_schema()),
            quote_identifier(&self.config.history_table)
        )
    }

    async fn discover_history_schema(
        &mut self,
    ) -> Result<Option<String>, SqlxMigrationExecutorError> {
        let table = self.config.history_table.clone();
        let preferred = self.config.history_schema.clone();
        let row = sqlx::query(
            "SELECT n.nspname AS schema_name\
             FROM pg_class c\
             JOIN pg_namespace n ON n.oid = c.relnamespace\
             WHERE c.relname = $1 AND c.relkind IN ('r', 'p')\
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')\
             ORDER BY CASE WHEN n.nspname = $2 THEN 0 WHEN n.nspname = 'public' THEN 1 ELSE 2 END, n.nspname\
             LIMIT 1",
        )
        .bind(table)
        .bind(preferred)
        .fetch_optional(&mut **self.connection_mut()?)
        .await?;
        let schema = row
            .map(|row| row.try_get::<String, _>("schema_name"))
            .transpose()?;
        self.resolved_history_schema = schema.clone();
        Ok(schema)
    }

    async fn history_columns(&mut self) -> Result<BTreeSet<String>, SqlxMigrationExecutorError> {
        let schema = self.history_schema().to_owned();
        let table = self.config.history_table.clone();
        let rows = sqlx::query(
            "SELECT column_name\
             FROM information_schema.columns\
             WHERE table_schema = $1 AND table_name = $2\
             ORDER BY ordinal_position",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&mut **self.connection_mut()?)
        .await?;
        rows.into_iter()
            .map(|row| row.try_get::<String, _>("column_name"))
            .collect::<Result<BTreeSet<_>, _>>()
            .map_err(Into::into)
    }

    async fn history_exists(&mut self) -> Result<bool, SqlxMigrationExecutorError> {
        Ok(self.discover_history_schema().await?.is_some())
    }
}

#[async_trait]
impl MigrationExecutor for SqlxMigrationExecutor {
    type Error = SqlxMigrationExecutorError;

    async fn acquire_advisory_lock(
        &mut self,
        name: &str,
        timeout: Duration,
    ) -> Result<LockAcquisition, Self::Error> {
        let mut connection = self.pool.acquire().await?;
        if !self.config.search_path.is_empty() {
            let search_path = self
                .config
                .search_path
                .iter()
                .map(|schema| quote_identifier(schema))
                .collect::<Vec<_>>()
                .join(", ");
            sqlx::query(&format!("SET search_path TO {search_path}"))
                .execute(&mut *connection)
                .await?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            let acquired = sqlx::query_scalar::<_, bool>(
                "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1))",
            )
            .bind(name)
            .fetch_one(&mut *connection)
            .await?;
            if acquired {
                self.connection = Some(connection);
                self.lock_held = true;
                self.held_lock_name = Some(name.to_owned());
                return Ok(LockAcquisition { acquired: true });
            }
            if timeout.is_zero() || Instant::now() >= deadline {
                return Ok(LockAcquisition { acquired: false });
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            sleep(self.config.lock_poll_interval.min(remaining)).await;
        }
    }

    async fn begin(&mut self) -> Result<(), Self::Error> {
        if !self.lock_held {
            return Err(SqlxMigrationExecutorError::ConnectionMissing);
        }
        sqlx::query("BEGIN")
            .execute(&mut **self.connection_mut()?)
            .await?;
        self.transaction_open = true;
        Ok(())
    }

    async fn database_non_empty(&mut self) -> Result<bool, Self::Error> {
        self.require_transaction()?;
        let schema = self.history_schema().to_owned();
        let table = self.config.history_table.clone();
        let row = sqlx::query(
            "SELECT EXISTS (\
               SELECT 1 FROM information_schema.tables\
               WHERE table_type = 'BASE TABLE'\
                 AND table_schema NOT IN ('pg_catalog', 'information_schema')\
                 AND NOT (table_schema = $1 AND table_name = $2)\
             ) AS non_empty",
        )
        .bind(schema)
        .bind(table)
        .fetch_one(&mut **self.connection_mut()?)
        .await?;
        Ok(row.try_get("non_empty")?)
    }

    async fn read_history(&mut self) -> Result<HistorySnapshot, Self::Error> {
        self.require_transaction()?;
        if !self.history_exists().await? {
            return Ok(HistorySnapshot::empty());
        }
        let columns = self.history_columns().await?;
        if !columns.contains("hash") || !columns.contains("created_at") {
            return Err(SqlxMigrationExecutorError::InvalidHistoryTable);
        }
        let mut selected = vec![quote_identifier("hash"), quote_identifier("created_at")];
        if columns.contains("name") {
            selected.push(quote_identifier("name"));
        }
        if columns.contains("id") {
            selected.push(quote_identifier("id"));
        }
        let order_column = if columns.contains("id") {
            "id"
        } else {
            "created_at"
        };
        let rows = sqlx::query(&format!(
            "SELECT {} FROM {} ORDER BY {} ASC",
            selected.join(", "),
            self.qualified_history_table(),
            quote_identifier(order_column),
        ))
        .fetch_all(&mut **self.connection_mut()?)
        .await?;
        let entries = rows
            .into_iter()
            .map(|row| {
                Ok(AppliedMigration {
                    hash: Some(row.try_get("hash")?),
                    name: if columns.contains("name") {
                        row.try_get("name")?
                    } else {
                        None
                    },
                    created_at: Some(row.try_get("created_at")?),
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
        Ok(HistorySnapshot {
            table_exists: true,
            entries,
        })
    }

    async fn ensure_history_table(&mut self) -> Result<(), Self::Error> {
        self.require_transaction()?;
        if self.history_exists().await? {
            return Ok(());
        }
        let schema = quote_identifier(&self.config.history_schema);
        sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS {schema}"))
            .execute(&mut **self.connection_mut()?)
            .await?;
        sqlx::query(&format!(
            "CREATE TABLE IF NOT EXISTS {}.{} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
            schema,
            quote_identifier(&self.config.history_table),
        ))
        .execute(&mut **self.connection_mut()?)
        .await?;
        self.resolved_history_schema = Some(self.config.history_schema.clone());
        Ok(())
    }

    async fn execute_statement(&mut self, statement: &str) -> Result<(), Self::Error> {
        self.require_transaction()?;
        sqlx::query(statement)
            .execute(&mut **self.connection_mut()?)
            .await?;
        Ok(())
    }

    async fn record_history(&mut self, entry: &AppliedMigration) -> Result<(), Self::Error> {
        self.require_transaction()?;
        let columns = self.history_columns().await?;
        if !columns.contains("hash") || !columns.contains("created_at") {
            return Err(SqlxMigrationExecutorError::InvalidHistoryTable);
        }
        let requested = entry.created_at.unwrap_or(0);
        let latest = sqlx::query_scalar::<_, Option<i64>>(&format!(
            "SELECT MAX({}) FROM {}",
            quote_identifier("created_at"),
            self.qualified_history_table(),
        ))
        .fetch_one(&mut **self.connection_mut()?)
        .await?
        .unwrap_or(0);
        let created_at = latest
            .checked_add(1)
            .ok_or(SqlxMigrationExecutorError::CreatedAtOverflow)?
            .max(requested);

        if columns.contains("name") {
            sqlx::query(&format!(
                "INSERT INTO {} ({}, {}, {}) VALUES ($1, $2, $3)",
                self.qualified_history_table(),
                quote_identifier("hash"),
                quote_identifier("created_at"),
                quote_identifier("name"),
            ))
            .bind(entry.hash.as_deref().unwrap_or_default())
            .bind(created_at)
            .bind(entry.name.as_deref().unwrap_or_default())
            .execute(&mut **self.connection_mut()?)
            .await?;
        } else {
            sqlx::query(&format!(
                "INSERT INTO {} ({}, {}) VALUES ($1, $2)",
                self.qualified_history_table(),
                quote_identifier("hash"),
                quote_identifier("created_at"),
            ))
            .bind(entry.hash.as_deref().unwrap_or_default())
            .bind(created_at)
            .execute(&mut **self.connection_mut()?)
            .await?;
        }
        Ok(())
    }

    async fn check_postconditions(&mut self) -> Result<HistorySnapshot, Self::Error> {
        self.read_history().await
    }

    async fn commit(&mut self) -> Result<(), Self::Error> {
        self.require_transaction()?;
        sqlx::query("COMMIT")
            .execute(&mut **self.connection_mut()?)
            .await?;
        self.transaction_open = false;
        Ok(())
    }

    async fn rollback(&mut self) -> Result<(), Self::Error> {
        if !self.transaction_open {
            return Ok(());
        }
        sqlx::query("ROLLBACK")
            .execute(&mut **self.connection_mut()?)
            .await?;
        self.transaction_open = false;
        Ok(())
    }

    async fn release_advisory_lock(&mut self) -> Result<(), Self::Error> {
        if !self.lock_held {
            return Ok(());
        }
        let lock_name = self
            .held_lock_name
            .clone()
            .ok_or(SqlxMigrationExecutorError::ConnectionMissing)?;
        let unlocked = sqlx::query_scalar::<_, bool>(
            "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))",
        )
        .bind(lock_name)
        .fetch_one(&mut **self.connection_mut()?)
        .await?;
        self.lock_held = false;
        self.held_lock_name = None;
        self.connection.take();
        if unlocked {
            Ok(())
        } else {
            Err(SqlxMigrationExecutorError::Sqlx(sqlx::Error::Protocol(
                "PostgreSQL advisory lock was not held".into(),
            )))
        }
    }
}

fn validate_identifier(identifier: &str) -> Result<(), SqlxMigrationExecutorError> {
    if identifier.is_empty()
        || identifier.len() > 63
        || !identifier.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || byte == b'_' && index > 0 || byte == b'_' && index == 0
        })
        || identifier.as_bytes()[0].is_ascii_digit()
    {
        return Err(SqlxMigrationExecutorError::InvalidIdentifier(
            identifier.to_owned(),
        ));
    }
    Ok(())
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}
