//! Ordered PostgreSQL migration application with the existing Drizzle journal.
//!
//! This service is intentionally opt-in. Callers provide the existing backup
//! operation through a callback; a non-empty database is never changed unless
//! the callback returns a checked recovery-point receipt that includes the
//! migration journal.

use crate::{MigrationPreflightDatabaseState, MigrationPreflightStatus, classify_preflight};
use rudder_migration_core::{
    MigrationEntry, MigrationLimits, MigrationManifest, MigrationSource, load_migration_manifest,
};
use rudder_migration_history_core::{
    MigrationHistoryError, MigrationHistoryPreflight, MigrationHistoryReason,
    MigrationHistorySnapshot, MigrationHistoryStatus, reconcile_migration_history,
};
use rudder_migration_history_postgres::{
    MigrationHistoryPostgresError, read_snapshot_on_connection,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row, raw_sql};
use std::{
    fs::{self, File},
    future::Future,
    io::Read,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::time::timeout;

/// Node's currently deployed session advisory lock identity. Keep this exact
/// value until the Node and Rust writers have a coordinated lock migration.
pub const NODE_MIGRATION_ADVISORY_LOCK_NAME: &str = "rudder:database-migrations";

const DRIZZLE_SCHEMA: &str = "drizzle";
const MIGRATION_HISTORY_TABLE: &str = "__drizzle_migrations";
const STATEMENT_BREAKPOINT: &str = "--> statement-breakpoint";
const ADVISORY_LOCK_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RECOVERY_POINT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// A backup provider's claim about one completed migration recovery point.
/// The apply service independently checks the file, size, checksum, and plain
/// `pg_dump` structure, including the actual migration-journal table and data
/// block, before allowing any schema or history mutation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRecoveryPointReceipt {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
    pub includes_migration_journal: bool,
}

/// Result of one locked migration application attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationApplyReport {
    pub manifest_fingerprint: String,
    pub already_current: bool,
    pub applied_migrations: Vec<String>,
    pub reconciled_legacy_migrations: Vec<String>,
    pub recovery_point: Option<PathBuf>,
}

/// Errors returned by the migration writer.
#[derive(Debug, Error)]
pub enum MigrationApplyError {
    #[error("migration source could not be loaded: {0}")]
    ManifestSource(#[from] rudder_migration_core::MigrationError),
    #[error("migration history postgres read failed: {0}")]
    HistoryPostgres(#[from] MigrationHistoryPostgresError),
    #[error("migration history reconciliation failed: {0}")]
    History(#[from] MigrationHistoryError),
    #[error("migration apply database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration source changed after it was inspected")]
    ManifestChanged,
    #[error("migration source validation worker failed: {0}")]
    SourceWorkerFailed(String),
    #[error(
        "database has application tables but no migration journal; refusing automatic migration"
    )]
    UnsafeLegacyDatabase,
    #[error("migration history is inconsistent: {0}")]
    HistoryMismatch(String),
    #[error("database claims migrations are current but required core tables are missing")]
    MissingCoreSchema,
    #[error("migration journal must have id, created_at, and hash or name columns")]
    InvalidJournalShape,
    #[error("migration recovery point is required for a non-empty database")]
    RecoveryPointRequired,
    #[error("migration recovery point provider failed: {0}")]
    RecoveryPointProvider(String),
    #[error("migration recovery point is invalid: {0}")]
    InvalidRecoveryPoint(String),
    #[error("migration file {file_name} could not be read: {source}")]
    MigrationFileRead {
        file_name: String,
        #[source]
        source: std::io::Error,
    },
    #[error("migration file {file_name} changed after manifest validation")]
    MigrationFileChanged { file_name: String },
    #[error("migration file {file_name} is not valid UTF-8")]
    MigrationFileNotUtf8 { file_name: String },
    #[error(
        "migration {file_name} is only partly present in the database; refusing automatic repair"
    )]
    PartialLegacyMigration { file_name: String },
    #[error("migration history already contains a conflicting entry for {file_name}")]
    ConflictingHistory { file_name: String },
    #[error("migration {file_name} failed: {source}")]
    MigrationFailed {
        file_name: String,
        #[source]
        source: sqlx::Error,
    },
    #[error("migration {file_name} created_at timestamp cannot be represented")]
    CreatedAtOutOfRange { file_name: String },
    #[error("migration {file_name} failed to roll back after an error: {source}")]
    RollbackFailed {
        file_name: String,
        #[source]
        source: sqlx::Error,
    },
    #[error("migration advisory lock could not be released")]
    AdvisoryUnlockFailed,
    #[error("timed out waiting for the migration advisory lock")]
    AdvisoryLockTimeout,
    #[error("post-migration database invariants failed: {0}")]
    Invariants(String),
}

/// Pool-backed migration writer. Its lock, reads, and transactions all use one
/// checked-out physical PostgreSQL connection.
#[derive(Clone)]
pub struct MigrationApplyService {
    pool: PgPool,
}

impl MigrationApplyService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self::new(pool)
    }

    /// Applies pending migration files in Drizzle order.
    ///
    /// `create_recovery_point` is called while the Node-compatible session
    /// advisory lock is held, but before any database mutation. The callback is
    /// not called for an already-current or empty database.
    pub async fn apply_pending_migrations<F, Fut>(
        &self,
        manifest: &MigrationManifest,
        source: &MigrationSource,
        create_recovery_point: F,
    ) -> Result<MigrationApplyReport, MigrationApplyError>
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = Result<MigrationRecoveryPointReceipt, String>> + Send,
    {
        let mut connection = self.pool.acquire().await?;
        // If this future is cancelled while the server is acquiring or holding
        // the session lock, close the physical connection instead of returning
        // a locked session to the pool.
        connection.close_on_drop();
        match timeout(
            ADVISORY_LOCK_TIMEOUT,
            acquire_node_migration_lock(&mut connection),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => return Err(MigrationApplyError::AdvisoryLockTimeout),
        }

        let result = self
            .apply_while_locked(&mut connection, manifest, source, create_recovery_point)
            .await;
        let unlock = release_node_migration_lock(&mut connection).await;
        match (result, unlock) {
            (Ok(report), Ok(())) => Ok(report),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn apply_while_locked<F, Fut>(
        &self,
        connection: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        manifest: &MigrationManifest,
        source: &MigrationSource,
        create_recovery_point: F,
    ) -> Result<MigrationApplyReport, MigrationApplyError>
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = Result<MigrationRecoveryPointReceipt, String>> + Send,
    {
        let current_manifest = load_current_manifest(source).await?;
        if current_manifest != *manifest {
            return Err(MigrationApplyError::ManifestChanged);
        }

        let (initial_snapshot, initial_database, initial_history, initial_report) =
            inspect_with_manifest(connection, manifest).await?;
        if initial_snapshot.table_schema.is_some() {
            validate_journal_columns(initial_snapshot.columns)?;
        }
        if initial_history.reason == MigrationHistoryReason::MigrationJournalInvalid {
            return Err(MigrationApplyError::InvalidJournalShape);
        }
        let mut reset_empty_history = false;
        match initial_report.status {
            MigrationPreflightStatus::Current => {
                verify_post_migration_invariants(connection, manifest).await?;
                return Ok(MigrationApplyReport {
                    manifest_fingerprint: manifest.fingerprint.clone(),
                    already_current: true,
                    applied_migrations: Vec::new(),
                    reconciled_legacy_migrations: Vec::new(),
                    recovery_point: None,
                });
            }
            MigrationPreflightStatus::Bootstrap | MigrationPreflightStatus::Pending => {}
            MigrationPreflightStatus::MissingCoreSchema if initial_database.table_count == 0 => {
                reset_empty_history = true;
            }
            MigrationPreflightStatus::MissingCoreSchema => {
                return Err(MigrationApplyError::MissingCoreSchema);
            }
            MigrationPreflightStatus::UnsafeLegacy => {
                return Err(MigrationApplyError::UnsafeLegacyDatabase);
            }
            MigrationPreflightStatus::Mismatch => {
                return Err(MigrationApplyError::HistoryMismatch(
                    initial_history.diagnostics.join("; "),
                ));
            }
        }

        // Drizzle history alone is still recoverable state. Preserve it even
        // when the public application schema has not been created yet.
        let must_back_up =
            initial_database.table_count > 0 || initial_snapshot.table_schema.is_some();
        let recovery_point = if must_back_up {
            let receipt = create_recovery_point()
                .await
                .map_err(MigrationApplyError::RecoveryPointProvider)?;
            validate_recovery_point_off_thread(receipt.clone()).await?;
            Some(receipt.path)
        } else {
            None
        };

        let reloaded_manifest = load_current_manifest(source).await?;
        if reloaded_manifest != *manifest {
            return Err(MigrationApplyError::ManifestChanged);
        }
        let (checked_snapshot, checked_database, checked_history, checked_report) =
            inspect_with_manifest(connection, manifest).await?;
        if checked_snapshot != initial_snapshot || checked_database != initial_database {
            return Err(MigrationApplyError::HistoryMismatch(
                "database state changed while the recovery point was being created".to_owned(),
            ));
        }
        if checked_history != initial_history || checked_report.status != initial_report.status {
            return Err(MigrationApplyError::HistoryMismatch(
                "migration history changed while the recovery point was being created".to_owned(),
            ));
        }

        let mut pending = if reset_empty_history
            || initial_report.status == MigrationPreflightStatus::Bootstrap
        {
            manifest.entries.iter().collect::<Vec<_>>()
        } else {
            initial_history
                .pending_migrations
                .iter()
                .map(|pending| {
                    manifest
                        .entries
                        .iter()
                        .find(|entry| entry.file_name == pending.file_name)
                        .ok_or_else(|| {
                            MigrationApplyError::HistoryMismatch(format!(
                                "pending migration {} is absent from the manifest",
                                pending.file_name
                            ))
                        })
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        pending.sort_by_key(|entry| entry.order);

        if reset_empty_history {
            reset_empty_migration_history(connection, &initial_snapshot).await?;
        } else if initial_snapshot.table_schema.is_none() {
            create_migration_history_table(connection).await?;
        }

        let journal_snapshot = read_snapshot_on_connection(connection).await?;
        let table_schema = journal_snapshot
            .table_schema
            .ok_or(MigrationApplyError::InvalidJournalShape)?;
        let columns = journal_snapshot.columns;
        validate_journal_columns(columns)?;

        let mut applied_migrations = Vec::new();
        let mut reconciled_legacy_migrations = Vec::new();
        for entry in pending {
            let sql = read_verified_migration_file(source, manifest, entry).await?;
            let (applied, reconciled) =
                apply_one_migration(connection, &table_schema, columns, entry, &sql).await?;
            if applied {
                applied_migrations.push(entry.file_name.clone());
            }
            if reconciled {
                reconciled_legacy_migrations.push(entry.file_name.clone());
            }
        }

        verify_post_migration_invariants(connection, manifest).await?;
        Ok(MigrationApplyReport {
            manifest_fingerprint: manifest.fingerprint.clone(),
            already_current: false,
            applied_migrations,
            reconciled_legacy_migrations,
            recovery_point,
        })
    }
}

async fn load_current_manifest(
    source: &MigrationSource,
) -> Result<MigrationManifest, MigrationApplyError> {
    let journal_path = source.journal_path().to_path_buf();
    let migrations_dir = source.migrations_dir().to_path_buf();
    tokio::task::spawn_blocking(move || {
        load_migration_manifest(&journal_path, &migrations_dir, MigrationLimits::default())
    })
    .await
    .map_err(|error| MigrationApplyError::SourceWorkerFailed(error.to_string()))?
    .map_err(MigrationApplyError::from)
}

async fn acquire_node_migration_lock(
    connection: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
) -> Result<(), MigrationApplyError> {
    sqlx::query("SELECT pg_advisory_lock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut **connection)
        .await?;
    Ok(())
}

async fn release_node_migration_lock(
    connection: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
) -> Result<(), MigrationApplyError> {
    let row = sqlx::query(
        "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1)) AS unlocked",
    )
    .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
    .fetch_one(&mut **connection)
    .await?;
    if row.try_get::<bool, _>("unlocked")? {
        Ok(())
    } else {
        Err(MigrationApplyError::AdvisoryUnlockFailed)
    }
}

async fn read_database_state(
    connection: &mut PgConnection,
) -> Result<MigrationPreflightDatabaseState, MigrationApplyError> {
    let row = sqlx::query(
        r#"
        SELECT
          COUNT(*)::bigint AS table_count,
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'public'
          ) AS core_schema_present,
          EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'organizations'
              AND table_type = 'BASE TABLE'
          ) AS organizations_table_present
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        "#,
    )
    .fetch_one(&mut *connection)
    .await?;
    let table_count = row.try_get::<i64, _>("table_count")?;
    let table_count = u64::try_from(table_count).map_err(|_| {
        MigrationApplyError::Invariants(format!("invalid public table count {table_count}"))
    })?;
    Ok(MigrationPreflightDatabaseState {
        table_count,
        core_schema_present: row.try_get("core_schema_present")?,
        organizations_table_present: row.try_get("organizations_table_present")?,
    })
}

fn validate_journal_columns(
    columns: rudder_migration_history_core::MigrationHistoryColumns,
) -> Result<(), MigrationApplyError> {
    if columns.id && columns.created_at && (columns.hash || columns.name) {
        Ok(())
    } else {
        Err(MigrationApplyError::InvalidJournalShape)
    }
}

async fn create_migration_history_table(
    connection: &mut PgConnection,
) -> Result<(), MigrationApplyError> {
    sqlx::query("BEGIN").execute(&mut *connection).await?;
    let result = async {
        raw_sql(
            r#"CREATE SCHEMA IF NOT EXISTS "drizzle";
               CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
                 "id" SERIAL PRIMARY KEY,
                 "hash" text NOT NULL,
                 "created_at" bigint
               );"#,
        )
        .execute(&mut *connection)
        .await?;
        Ok::<_, sqlx::Error>(())
    }
    .await;
    match result {
        Ok(()) => {
            sqlx::query("COMMIT").execute(&mut *connection).await?;
            Ok(())
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(MigrationApplyError::Database(error))
        }
    }
}

async fn reset_empty_migration_history(
    connection: &mut PgConnection,
    snapshot: &MigrationHistorySnapshot,
) -> Result<(), MigrationApplyError> {
    let Some(schema) = snapshot.table_schema.as_deref() else {
        return create_migration_history_table(connection).await;
    };
    let quoted_schema = quote_identifier(schema)?;
    let quoted_table = quote_identifier(MIGRATION_HISTORY_TABLE)?;
    sqlx::query("BEGIN").execute(&mut *connection).await?;
    let result = async {
        raw_sql(&format!(
            "DROP TABLE IF EXISTS {quoted_schema}.{quoted_table};"
        ))
        .execute(&mut *connection)
        .await?;
        if schema == DRIZZLE_SCHEMA {
            raw_sql("DROP SCHEMA IF EXISTS \"drizzle\";")
                .execute(&mut *connection)
                .await?;
        }
        raw_sql(
            r#"CREATE SCHEMA IF NOT EXISTS "drizzle";
               CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
                 "id" SERIAL PRIMARY KEY,
                 "hash" text NOT NULL,
                 "created_at" bigint
               );"#,
        )
        .execute(&mut *connection)
        .await?;
        Ok::<_, sqlx::Error>(())
    }
    .await;
    match result {
        Ok(()) => {
            sqlx::query("COMMIT").execute(&mut *connection).await?;
            Ok(())
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(MigrationApplyError::Database(error))
        }
    }
}

fn quote_identifier(value: &str) -> Result<String, MigrationApplyError> {
    if value.is_empty()
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_'
                || byte.is_ascii_alphanumeric() && (index > 0 || byte.is_ascii_alphabetic())
        })
    {
        return Err(MigrationApplyError::InvalidJournalShape);
    }
    Ok(format!("\"{value}\""))
}

async fn read_verified_migration_file(
    source: &MigrationSource,
    manifest: &MigrationManifest,
    entry: &MigrationEntry,
) -> Result<String, MigrationApplyError> {
    let Some(expected) = manifest
        .entries
        .iter()
        .find(|expected| expected.file_name == entry.file_name)
    else {
        return Err(MigrationApplyError::ManifestChanged);
    };
    let directory = source.migrations_dir().to_path_buf();
    let file_name = entry.file_name.clone();
    let expected_byte_size = expected.byte_size;
    let expected_sha256 = expected.sha256.clone();
    tokio::task::spawn_blocking(move || {
        read_verified_migration_file_sync(
            &directory,
            &file_name,
            expected_byte_size,
            &expected_sha256,
        )
    })
    .await
    .map_err(|error| MigrationApplyError::SourceWorkerFailed(error.to_string()))?
}

fn read_verified_migration_file_sync(
    directory: &std::path::Path,
    file_name: &str,
    expected_byte_size: u64,
    expected_sha256: &str,
) -> Result<String, MigrationApplyError> {
    let path = directory.join(file_name);
    let metadata =
        fs::symlink_metadata(&path).map_err(|source| MigrationApplyError::MigrationFileRead {
            file_name: file_name.to_owned(),
            source,
        })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(MigrationApplyError::MigrationFileChanged {
            file_name: file_name.to_owned(),
        });
    }
    let bytes = fs::read(&path).map_err(|source| MigrationApplyError::MigrationFileRead {
        file_name: file_name.to_owned(),
        source,
    })?;
    if bytes.len() as u64 != expected_byte_size || sha256_hex(&bytes) != expected_sha256 {
        return Err(MigrationApplyError::MigrationFileChanged {
            file_name: file_name.to_owned(),
        });
    }
    String::from_utf8(bytes).map_err(|_| MigrationApplyError::MigrationFileNotUtf8 {
        file_name: file_name.to_owned(),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn validate_recovery_point_off_thread(
    receipt: MigrationRecoveryPointReceipt,
) -> Result<(), MigrationApplyError> {
    tokio::task::spawn_blocking(move || validate_recovery_point(&receipt))
        .await
        .map_err(|error| MigrationApplyError::SourceWorkerFailed(error.to_string()))?
}

fn validate_recovery_point(
    receipt: &MigrationRecoveryPointReceipt,
) -> Result<(), MigrationApplyError> {
    if !receipt.includes_migration_journal {
        return Err(MigrationApplyError::InvalidRecoveryPoint(
            "receipt says the Drizzle journal was excluded".to_owned(),
        ));
    }
    if !receipt.path.is_absolute() {
        return Err(MigrationApplyError::InvalidRecoveryPoint(
            "backup path must be absolute".to_owned(),
        ));
    }
    let metadata = fs::symlink_metadata(&receipt.path).map_err(|error| {
        MigrationApplyError::InvalidRecoveryPoint(format!("backup file is unavailable: {error}"))
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(MigrationApplyError::InvalidRecoveryPoint(
            "backup path must name a regular file".to_owned(),
        ));
    }
    if metadata.len() == 0 || metadata.len() != receipt.size_bytes {
        return Err(MigrationApplyError::InvalidRecoveryPoint(
            "backup size does not match the receipt or is empty".to_owned(),
        ));
    }
    if metadata.len() > MAX_RECOVERY_POINT_BYTES {
        return Err(MigrationApplyError::InvalidRecoveryPoint(format!(
            "backup exceeds the {} byte validation limit",
            MAX_RECOVERY_POINT_BYTES
        )));
    }

    let mut file = File::open(&receipt.path).map_err(|error| {
        MigrationApplyError::InvalidRecoveryPoint(format!(
            "backup file could not be opened: {error}"
        ))
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut prefix = Vec::with_capacity(b"-- Rudder database backup".len());
    let mut structure = RecoveryDumpStructure::default();
    let mut line_prefix = Vec::with_capacity(RECOVERY_DUMP_LINE_PREFIX_CAPACITY);
    let mut line_length = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            MigrationApplyError::InvalidRecoveryPoint(format!(
                "backup file could not be read: {error}"
            ))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        if prefix.len() < b"-- Rudder database backup".len() {
            let missing = b"-- Rudder database backup".len() - prefix.len();
            prefix.extend_from_slice(&buffer[..read.min(missing)]);
        }
        for byte in &buffer[..read] {
            if *byte == b'\n' {
                inspect_recovery_dump_line(&line_prefix, line_length, &mut structure);
                line_prefix.clear();
                line_length = 0;
            } else {
                line_length = line_length.saturating_add(1);
                if line_prefix.len() < RECOVERY_DUMP_LINE_PREFIX_CAPACITY {
                    line_prefix.push(*byte);
                }
            }
        }
    }
    if line_length > 0 {
        inspect_recovery_dump_line(&line_prefix, line_length, &mut structure);
    }
    let actual_sha = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual_sha != receipt.sha256 {
        return Err(MigrationApplyError::InvalidRecoveryPoint(
            "backup checksum does not match the receipt".to_owned(),
        ));
    }
    if !prefix.starts_with(b"-- Rudder database backup") {
        return Err(MigrationApplyError::InvalidRecoveryPoint(
            "backup file is not a Rudder SQL recovery point".to_owned(),
        ));
    }
    if !structure.is_complete() {
        return Err(MigrationApplyError::InvalidRecoveryPoint(
            "backup file is not a complete plain PostgreSQL dump containing the migration journal"
                .to_owned(),
        ));
    }
    Ok(())
}

const RECOVERY_DUMP_LINE_PREFIX_CAPACITY: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryJournalSchema {
    Drizzle,
    Public,
}

#[derive(Default)]
struct RecoveryDumpStructure {
    has_rudder_header: bool,
    has_postgres_header: bool,
    journal_schema: Option<RecoveryJournalSchema>,
    has_journal_copy: bool,
    journal_copy_terminated: bool,
    has_postgres_footer: bool,
}

impl RecoveryDumpStructure {
    fn is_complete(&self) -> bool {
        self.has_rudder_header
            && self.has_postgres_header
            && self.journal_schema.is_some()
            && self.has_journal_copy
            && self.journal_copy_terminated
            && self.has_postgres_footer
    }
}

fn inspect_recovery_dump_line(
    prefix: &[u8],
    line_length: u64,
    structure: &mut RecoveryDumpStructure,
) {
    if line_length != prefix.len() as u64 {
        return;
    }
    let line = prefix.strip_suffix(b"\r").unwrap_or(prefix);
    if ascii_line_eq(line, b"-- Rudder database backup") {
        structure.has_rudder_header = true;
    }
    if ascii_line_eq(line, b"-- PostgreSQL database dump") {
        structure.has_postgres_header = true;
        return;
    }
    if !structure.has_postgres_header {
        return;
    }
    if structure.journal_schema.is_none() {
        structure.journal_schema = parse_journal_table_statement(line);
    }
    if !structure.has_journal_copy
        && let Some(schema) = parse_journal_copy_statement(line)
        && structure.journal_schema == Some(schema)
    {
        structure.has_journal_copy = true;
        return;
    }
    if structure.has_journal_copy && !structure.journal_copy_terminated && line == b"\\." {
        structure.journal_copy_terminated = true;
        return;
    }
    if structure.journal_copy_terminated
        && ascii_line_eq(line, b"-- PostgreSQL database dump complete")
    {
        structure.has_postgres_footer = true;
    }
}

fn ascii_line_eq(value: &[u8], expected: &[u8]) -> bool {
    value.eq_ignore_ascii_case(expected)
}

fn parse_journal_table_statement(line: &[u8]) -> Option<RecoveryJournalSchema> {
    let mut cursor = 0;
    if !take_sql_keyword(line, &mut cursor, b"CREATE")
        || !take_sql_keyword(line, &mut cursor, b"TABLE")
    {
        return None;
    }
    let schema = parse_qualified_journal_name(line, &mut cursor)?;
    skip_sql_whitespace(line, &mut cursor);
    if line.get(cursor) != Some(&b'(') {
        return None;
    }
    Some(schema)
}

fn parse_journal_copy_statement(line: &[u8]) -> Option<RecoveryJournalSchema> {
    let mut cursor = 0;
    if !take_sql_keyword(line, &mut cursor, b"COPY") {
        return None;
    }
    let schema = parse_qualified_journal_name(line, &mut cursor)?;
    skip_sql_whitespace(line, &mut cursor);
    let tail = line.get(cursor..)?;
    let tail = trim_sql_whitespace(tail);
    let lower_tail = tail.iter().map(u8::to_ascii_lowercase).collect::<Vec<_>>();
    let has_copy_columns = tail.first() == Some(&b'(')
        && lower_tail
            .iter()
            .rposition(|byte| *byte == b')')
            .is_some_and(|close| trim_sql_whitespace(&lower_tail[close + 1..]) == b"from stdin;");
    let has_copy_without_columns = lower_tail == b"from stdin;";
    (has_copy_columns || has_copy_without_columns).then_some(schema)
}

fn parse_qualified_journal_name(line: &[u8], cursor: &mut usize) -> Option<RecoveryJournalSchema> {
    let schema = parse_sql_identifier(line, cursor)?;
    skip_sql_whitespace(line, cursor);
    if line.get(*cursor) != Some(&b'.') {
        return None;
    }
    *cursor += 1;
    let table = parse_sql_identifier(line, cursor)?;
    if table != "__drizzle_migrations" {
        return None;
    }
    match schema.as_str() {
        "drizzle" => Some(RecoveryJournalSchema::Drizzle),
        "public" => Some(RecoveryJournalSchema::Public),
        _ => None,
    }
}

fn parse_sql_identifier(line: &[u8], cursor: &mut usize) -> Option<String> {
    skip_sql_whitespace(line, cursor);
    if line.get(*cursor) == Some(&b'"') {
        *cursor += 1;
        let mut identifier = Vec::new();
        loop {
            match line.get(*cursor).copied()? {
                b'"' if line.get(*cursor + 1) == Some(&b'"') => {
                    identifier.push(b'"');
                    *cursor += 2;
                }
                b'"' => {
                    *cursor += 1;
                    return String::from_utf8(identifier).ok();
                }
                byte => {
                    identifier.push(byte);
                    *cursor += 1;
                }
            }
        }
    }
    let start = *cursor;
    while line
        .get(*cursor)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'$')
    {
        *cursor += 1;
    }
    if *cursor == start {
        return None;
    }
    String::from_utf8(
        line[start..*cursor]
            .iter()
            .map(u8::to_ascii_lowercase)
            .collect(),
    )
    .ok()
}

fn take_sql_keyword(line: &[u8], cursor: &mut usize, keyword: &[u8]) -> bool {
    skip_sql_whitespace(line, cursor);
    let Some(end) = (*cursor).checked_add(keyword.len()) else {
        return false;
    };
    if !line
        .get(*cursor..end)
        .is_some_and(|value| value.eq_ignore_ascii_case(keyword))
        || !line.get(end).is_some_and(|byte| byte.is_ascii_whitespace())
    {
        return false;
    }
    *cursor = end;
    true
}

fn skip_sql_whitespace(line: &[u8], cursor: &mut usize) {
    while line
        .get(*cursor)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        *cursor += 1;
    }
}

fn trim_sql_whitespace(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(|byte| byte.is_ascii_whitespace()) {
        value = &value[1..];
    }
    while value.last().is_some_and(|byte| byte.is_ascii_whitespace()) {
        value = &value[..value.len() - 1];
    }
    value
}

async fn apply_one_migration(
    connection: &mut PgConnection,
    table_schema: &str,
    columns: rudder_migration_history_core::MigrationHistoryColumns,
    entry: &MigrationEntry,
    sql: &str,
) -> Result<(bool, bool), MigrationApplyError> {
    sqlx::query("BEGIN").execute(&mut *connection).await?;
    let result = async {
        let existing = find_history_entry(connection, table_schema, columns, entry).await?;
        if let Some(matches) = existing {
            if !matches {
                return Err(MigrationApplyError::ConflictingHistory {
                    file_name: entry.file_name.clone(),
                });
            }
            return Ok((false, false));
        }

        let already_applied = if entry.is_legacy_unjournaled() {
            match inspect_known_legacy_migration(connection, &entry.file_name).await? {
                LegacyMigrationState::Applied => true,
                LegacyMigrationState::NotApplied => false,
                LegacyMigrationState::Partial => {
                    return Err(MigrationApplyError::PartialLegacyMigration {
                        file_name: entry.file_name.clone(),
                    });
                }
            }
        } else {
            false
        };

        if !already_applied {
            for statement in split_migration_statements(sql) {
                raw_sql(statement)
                    .execute(&mut *connection)
                    .await
                    .map_err(|source| MigrationApplyError::MigrationFailed {
                        file_name: entry.file_name.clone(),
                        source,
                    })?;
            }
        }
        insert_history_entry(connection, table_schema, columns, entry).await?;
        Ok((!already_applied, already_applied))
    }
    .await;

    match result {
        Ok(outcome) => {
            sqlx::query("COMMIT").execute(&mut *connection).await?;
            Ok(outcome)
        }
        Err(error) => match sqlx::query("ROLLBACK").execute(&mut *connection).await {
            Ok(_) => Err(error),
            Err(source) => Err(MigrationApplyError::RollbackFailed {
                file_name: entry.file_name.clone(),
                source,
            }),
        },
    }
}

fn split_migration_statements(sql: &str) -> impl Iterator<Item = &str> {
    sql.split(STATEMENT_BREAKPOINT)
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
}

async fn find_history_entry(
    connection: &mut PgConnection,
    schema: &str,
    columns: rudder_migration_history_core::MigrationHistoryColumns,
    entry: &MigrationEntry,
) -> Result<Option<bool>, MigrationApplyError> {
    let quoted_schema = quote_identifier(schema)?;
    let quoted_table = quote_identifier(MIGRATION_HISTORY_TABLE)?;
    let mut selected = Vec::new();
    if columns.hash {
        selected.push(quote_identifier("hash")?);
    }
    if columns.name {
        selected.push(quote_identifier("name")?);
    }
    let mut predicates = Vec::new();
    let mut index = 1;
    if columns.hash {
        predicates.push(format!("{} = ${index}", quote_identifier("hash")?));
        index += 1;
    }
    if columns.name {
        predicates.push(format!("{} = ${index}", quote_identifier("name")?));
    }
    let statement = format!(
        "SELECT {} FROM {quoted_schema}.{quoted_table} WHERE {}",
        selected.join(", "),
        predicates.join(" OR "),
    );
    let mut query = sqlx::query(&statement);
    if columns.hash {
        query = query.bind(&entry.sha256);
    }
    if columns.name {
        query = query.bind(&entry.file_name);
    }
    let rows = query.fetch_all(&mut *connection).await?;
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() > 1 {
        return Ok(Some(false));
    }
    let row = &rows[0];
    let hash = if columns.hash {
        row.try_get::<Option<String>, _>("hash")?
    } else {
        None
    };
    let name = if columns.name {
        row.try_get::<Option<String>, _>("name")?
    } else {
        None
    };
    let matches = hash.as_deref().is_none_or(|value| value == entry.sha256)
        && name.as_deref().is_none_or(|value| value == entry.file_name);
    Ok(Some(matches))
}

async fn insert_history_entry(
    connection: &mut PgConnection,
    schema: &str,
    columns: rudder_migration_history_core::MigrationHistoryColumns,
    entry: &MigrationEntry,
) -> Result<(), MigrationApplyError> {
    validate_journal_columns(columns)?;
    let quoted_schema = quote_identifier(schema)?;
    let quoted_table = quote_identifier(MIGRATION_HISTORY_TABLE)?;
    let mut insert_columns = Vec::new();
    let mut values = Vec::new();
    let mut parameter = 1;
    if columns.hash {
        insert_columns.push(quote_identifier("hash")?);
        values.push(format!("${parameter}"));
        parameter += 1;
    }
    if columns.name {
        insert_columns.push(quote_identifier("name")?);
        values.push(format!("${parameter}"));
        parameter += 1;
    }
    insert_columns.push(quote_identifier("created_at")?);
    values.push(format!("${parameter}"));
    let statement = format!(
        "INSERT INTO {quoted_schema}.{quoted_table} ({}) VALUES ({})",
        insert_columns.join(", "),
        values.join(", "),
    );

    let latest = sqlx::query(&format!(
        "SELECT {} FROM {quoted_schema}.{quoted_table} ORDER BY {} DESC NULLS LAST LIMIT 1",
        quote_identifier("created_at")?,
        quote_identifier("created_at")?,
    ))
    .fetch_optional(&mut *connection)
    .await?
    .map(|row| row.try_get::<Option<i64>, _>("created_at"))
    .transpose()?;
    let folder_millis = entry
        .journal_entry
        .as_ref()
        .map(|journal| journal.when)
        .unwrap_or_else(current_time_millis);
    let created_at = next_migration_created_at(latest.flatten(), folder_millis, &entry.file_name)?;

    let mut query = sqlx::query(&statement);
    if columns.hash {
        query = query.bind(&entry.sha256);
    }
    if columns.name {
        query = query.bind(&entry.file_name);
    }
    query = query.bind(created_at);
    query.execute(&mut *connection).await?;
    Ok(())
}

fn next_migration_created_at(
    latest_created_at: Option<i64>,
    folder_millis: u64,
    file_name: &str,
) -> Result<i64, MigrationApplyError> {
    let folder_millis =
        i64::try_from(folder_millis).map_err(|_| MigrationApplyError::CreatedAtOutOfRange {
            file_name: file_name.to_owned(),
        })?;
    match latest_created_at {
        Some(latest) => Ok(latest
            .checked_add(1)
            .ok_or_else(|| MigrationApplyError::CreatedAtOutOfRange {
                file_name: file_name.to_owned(),
            })?
            .max(folder_millis)),
        None => Ok(folder_millis),
    }
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LegacyMigrationState {
    Applied,
    NotApplied,
    Partial,
}

async fn inspect_known_legacy_migration(
    connection: &mut PgConnection,
    file_name: &str,
) -> Result<LegacyMigrationState, MigrationApplyError> {
    match file_name {
        // This shipped legacy SQL is intentionally a no-op and has no catalog
        // effect to reconcile. Execute and record it once like Node does.
        "0055_illegal_sheva_callister.sql" => Ok(LegacyMigrationState::NotApplied),
        // This shipped entry creates a single heartbeat-runs index. Existing
        // databases may already have it without a journal row, so compare its
        // catalog definition and validity before deciding to record it.
        "0128_modern_jetstream.sql" => {
            let row = sqlx::query(
                r#"
                SELECT
                  EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_index i
                    JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
                    JOIN pg_catalog.pg_namespace idx_ns ON idx_ns.oid = idx.relnamespace
                    JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
                    JOIN pg_catalog.pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
                    WHERE idx_ns.nspname = 'public'
                      AND idx.relname = 'heartbeat_runs_org_agent_created_id_idx'
                      AND tbl_ns.nspname = 'public'
                      AND tbl.relname = 'heartbeat_runs'
                      AND i.indisvalid AND i.indisready
                  ) AS valid_index_present,
                  EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_class idx
                    JOIN pg_catalog.pg_namespace n ON n.oid = idx.relnamespace
                    WHERE n.nspname = 'public'
                      AND idx.relname = 'heartbeat_runs_org_agent_created_id_idx'
                  ) AS index_exists,
                  (
                    SELECT pg_catalog.pg_get_indexdef(i.indexrelid)
                    FROM pg_catalog.pg_index i
                    JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = idx.relnamespace
                    WHERE n.nspname = 'public'
                      AND idx.relname = 'heartbeat_runs_org_agent_created_id_idx'
                    LIMIT 1
                  ) AS index_definition
                "#,
            )
            .fetch_one(&mut *connection)
            .await?;
            let valid_index_present: bool = row.try_get("valid_index_present")?;
            let index_exists: bool = row.try_get("index_exists")?;
            let index_definition: Option<String> = row.try_get("index_definition")?;
            if !index_exists {
                Ok(LegacyMigrationState::NotApplied)
            } else if valid_index_present
                && index_definition
                    .as_deref()
                    .is_some_and(is_expected_legacy_0128_index_definition)
            {
                Ok(LegacyMigrationState::Applied)
            } else {
                Ok(LegacyMigrationState::Partial)
            }
        }
        _ => Ok(LegacyMigrationState::Partial),
    }
}

fn is_expected_legacy_0128_index_definition(definition: &str) -> bool {
    let normalized = definition
        .to_ascii_lowercase()
        .replace('"', "")
        .replace(" nulls first", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    normalized
        == "create index heartbeat_runs_org_agent_created_id_idx on public.heartbeat_runs using btree (org_id, agent_id, created_at desc, id desc)"
}

async fn verify_post_migration_invariants(
    connection: &mut PgConnection,
    manifest: &MigrationManifest,
) -> Result<(), MigrationApplyError> {
    let (snapshot, database, history, report) = inspect_with_manifest(connection, manifest).await?;
    if report.status != MigrationPreflightStatus::Current
        || history.status != MigrationHistoryStatus::UpToDate
        || history.reason != MigrationHistoryReason::ManifestMatch
    {
        return Err(MigrationApplyError::Invariants(format!(
            "migration journal is not current ({:?}: {})",
            history.reason,
            history.diagnostics.join("; ")
        )));
    }
    validate_journal_columns(snapshot.columns)?;
    if !database.core_schema_present || !database.organizations_table_present {
        return Err(MigrationApplyError::Invariants(
            "public organizations table is missing".to_owned(),
        ));
    }

    let row = sqlx::query(
        r#"
        SELECT
          (SELECT count(*) FROM pg_catalog.pg_constraint c
            JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_catalog.pg_index i ON i.indexrelid = c.conindid
            WHERE n.nspname = 'public' AND t.relname = 'organizations'
              AND c.contype = 'p' AND c.convalidated AND i.indisvalid AND i.indisready) AS valid_primary_keys,
          (SELECT count(*) FROM pg_catalog.pg_constraint c
            JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' AND c.contype = 'f') AS foreign_keys,
          (SELECT count(*) FROM pg_catalog.pg_constraint c
            JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' AND c.contype = 'f' AND NOT c.convalidated) AS unvalidated_foreign_keys,
          (SELECT count(*) FROM pg_catalog.pg_index i
            JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' AND (NOT i.indisvalid OR NOT i.indisready)) AS invalid_indexes
        "#,
    )
    .fetch_one(&mut *connection)
    .await?;
    let valid_primary_keys: i64 = row.try_get("valid_primary_keys")?;
    let foreign_keys: i64 = row.try_get("foreign_keys")?;
    let unvalidated_foreign_keys: i64 = row.try_get("unvalidated_foreign_keys")?;
    let invalid_indexes: i64 = row.try_get("invalid_indexes")?;
    let mut issues = Vec::new();
    if valid_primary_keys != 1 {
        issues.push("organizations primary key is missing or invalid".to_owned());
    }
    if foreign_keys == 0 {
        issues.push("no public foreign keys were found".to_owned());
    }
    if unvalidated_foreign_keys > 0 {
        issues.push(format!(
            "{unvalidated_foreign_keys} foreign keys are unvalidated"
        ));
    }
    if invalid_indexes > 0 {
        issues.push(format!(
            "{invalid_indexes} indexes are invalid or not ready"
        ));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(MigrationApplyError::Invariants(issues.join("; ")))
    }
}

async fn inspect_with_manifest(
    connection: &mut PgConnection,
    manifest: &MigrationManifest,
) -> Result<
    (
        MigrationHistorySnapshot,
        MigrationPreflightDatabaseState,
        MigrationHistoryPreflight,
        crate::MigrationPreflightReport,
    ),
    MigrationApplyError,
> {
    sqlx::query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *connection)
        .await?;
    let result = async {
        let snapshot = read_snapshot_on_connection(connection).await?;
        let database = read_database_state(connection).await?;
        let history = reconcile_migration_history(manifest, &snapshot)?;
        Ok::<_, MigrationApplyError>((snapshot, database, history))
    }
    .await;
    match result {
        Ok((snapshot, database, history)) => {
            sqlx::query("COMMIT").execute(&mut *connection).await?;
            let report = classify_preflight(&snapshot, history.clone(), database);
            Ok((snapshot, database, history, report))
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rudder_migration_core::{MigrationManifestOptions, load_migration_manifest_with_options};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn splits_only_on_the_existing_drizzle_breakpoint() {
        let statements = split_migration_statements(
            "  SELECT 1;\n--> statement-breakpoint\n\nDO $$ BEGIN PERFORM 2; END $$;\n",
        )
        .collect::<Vec<_>>();
        assert_eq!(statements, ["SELECT 1;", "DO $$ BEGIN PERFORM 2; END $$;"]);
    }

    #[test]
    fn migration_file_is_rechecked_against_manifest_size_and_sha256() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("0000_probe.sql");
        let original = b"SELECT 1;";
        fs::write(&path, original).unwrap();
        assert_eq!(
            read_verified_migration_file_sync(
                directory.path(),
                "0000_probe.sql",
                original.len() as u64,
                &sha256_hex(original),
            )
            .unwrap(),
            "SELECT 1;"
        );

        fs::write(&path, b"SELECT 2;").unwrap();
        assert!(matches!(
            read_verified_migration_file_sync(
                directory.path(),
                "0000_probe.sql",
                original.len() as u64,
                &sha256_hex(original),
            ),
            Err(MigrationApplyError::MigrationFileChanged { .. })
        ));
    }

    #[test]
    fn recovery_receipt_requires_a_complete_pg_dump_journal_block() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pre-migration.sql");
        let content = complete_recovery_dump();
        fs::write(&path, content).unwrap();
        let receipt = MigrationRecoveryPointReceipt {
            path: path.clone(),
            size_bytes: content.len() as u64,
            sha256: sha256_hex(content),
            includes_migration_journal: true,
        };
        assert!(validate_recovery_point(&receipt).is_ok());

        let bad_digest = MigrationRecoveryPointReceipt {
            sha256: "0".repeat(64),
            ..receipt.clone()
        };
        assert!(matches!(
            validate_recovery_point(&bad_digest),
            Err(MigrationApplyError::InvalidRecoveryPoint(_))
        ));

        let public_dump = String::from_utf8(content.to_vec()).unwrap().replace(
            "drizzle.__drizzle_migrations",
            "public.__drizzle_migrations",
        );
        fs::write(&path, &public_dump).unwrap();
        let public_receipt = receipt_for_content(path.clone(), public_dump.as_bytes());
        assert!(validate_recovery_point(&public_receipt).is_ok());

        let omitted_journal = MigrationRecoveryPointReceipt {
            includes_migration_journal: false,
            ..receipt
        };
        assert!(matches!(
            validate_recovery_point(&omitted_journal),
            Err(MigrationApplyError::InvalidRecoveryPoint(_))
        ));
    }

    #[test]
    fn recovery_receipt_rejects_marker_only_unrelated_and_truncated_dumps() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pre-migration.sql");
        let content = complete_recovery_dump();
        let cases: [&[u8]; 4] = [
            b"-- Rudder database backup\n-- Table: drizzle.__drizzle_migrations\n",
            &content[..content.windows(3).position(|window| window == b"\\.\n").unwrap()],
            &content[..content.len() - b"-- PostgreSQL database dump complete\n--\n".len()],
            b"-- Rudder database backup\n-- PostgreSQL database dump\nCREATE TABLE public.unrelated (id integer);\nCOPY public.unrelated (id) FROM stdin;\n1\n\\.\n-- PostgreSQL database dump complete\n",
        ];
        for (index, invalid) in cases.into_iter().enumerate() {
            fs::write(&path, invalid).unwrap();
            let receipt = receipt_for_content(path.clone(), invalid);
            assert!(
                matches!(
                    validate_recovery_point(&receipt),
                    Err(MigrationApplyError::InvalidRecoveryPoint(_))
                ),
                "invalid backup case {index} unexpectedly passed"
            );
        }
    }

    fn complete_recovery_dump() -> &'static [u8] {
        b"-- Rudder database backup\n--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\nCREATE SCHEMA drizzle;\nCREATE TABLE drizzle.__drizzle_migrations (\n    id integer NOT NULL,\n    hash text NOT NULL,\n    created_at bigint\n);\nCOPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;\n1\tabc\t1000\n\\.\n--\n-- PostgreSQL database dump complete\n--\n"
    }

    fn receipt_for_content(
        path: std::path::PathBuf,
        content: &[u8],
    ) -> MigrationRecoveryPointReceipt {
        MigrationRecoveryPointReceipt {
            path,
            size_bytes: content.len() as u64,
            sha256: sha256_hex(content),
            includes_migration_journal: true,
        }
    }

    #[test]
    fn shipped_manifest_allowlisted_unjournaled_entries_are_valid_apply_work() {
        let migrations = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/db/src/migrations");
        let manifest = load_migration_manifest(
            &migrations.join("meta/_journal.json"),
            &migrations,
            MigrationLimits::default(),
        )
        .unwrap();
        let legacy = manifest
            .entries
            .iter()
            .filter(|entry| entry.is_legacy_unjournaled())
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            legacy,
            [
                "0055_illegal_sheva_callister.sql",
                "0128_modern_jetstream.sql"
            ]
        );
        assert!(manifest.entries.iter().all(|entry| {
            entry.is_legacy_unjournaled()
                || entry
                    .journal_entry
                    .as_ref()
                    .is_some_and(|journal| journal.idx < manifest.journal.entries.len())
        }));
    }

    #[test]
    fn custom_allowlisted_unjournaled_migration_is_present_in_manifest() {
        let root = TempDir::new().unwrap();
        let migrations = root.path().join("migrations");
        fs::create_dir_all(migrations.join("meta")).unwrap();
        fs::write(migrations.join("0000_first.sql"), "SELECT 1;").unwrap();
        fs::write(migrations.join("legacy.sql"), "SELECT 2;").unwrap();
        fs::write(
            migrations.join("meta/_journal.json"),
            r#"{"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1000,"tag":"0000_first","breakpoints":true}]}"#,
        )
        .unwrap();
        let manifest = load_migration_manifest_with_options(
            &migrations.join("meta/_journal.json"),
            &migrations,
            MigrationManifestOptions {
                limits: MigrationLimits::default(),
                legacy_unjournaled: vec!["legacy.sql".to_owned()],
            },
        )
        .unwrap();
        assert_eq!(manifest.entries.len(), 2);
        assert!(manifest.entries[1].is_legacy_unjournaled());
    }

    #[test]
    fn created_at_matches_node_folder_timestamp_ordering() {
        assert_eq!(
            next_migration_created_at(None, 1_000, "next.sql").unwrap(),
            1_000
        );
        assert_eq!(
            next_migration_created_at(Some(1_000), 900, "next.sql").unwrap(),
            1_001
        );
        assert_eq!(
            next_migration_created_at(Some(1_000), 1_500, "next.sql").unwrap(),
            1_500
        );
        assert!(matches!(
            next_migration_created_at(Some(i64::MAX), 1_500, "next.sql"),
            Err(MigrationApplyError::CreatedAtOutOfRange { .. })
        ));
    }

    #[test]
    fn legacy_0128_catalog_definition_must_match_the_shipped_index() {
        assert!(is_expected_legacy_0128_index_definition(
            "CREATE INDEX heartbeat_runs_org_agent_created_id_idx ON public.heartbeat_runs USING btree (org_id, agent_id, created_at DESC, id DESC)"
        ));
        assert!(is_expected_legacy_0128_index_definition(
            "CREATE INDEX heartbeat_runs_org_agent_created_id_idx ON public.heartbeat_runs USING btree (org_id, agent_id, created_at DESC NULLS FIRST, id DESC NULLS FIRST)"
        ));
        assert!(!is_expected_legacy_0128_index_definition(
            "CREATE INDEX heartbeat_runs_org_agent_created_id_idx ON public.heartbeat_runs USING btree (org_id, agent_id, created_at, id)"
        ));
    }
}
