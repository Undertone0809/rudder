//! Read-only migration preflight over one PostgreSQL snapshot.
//!
//! This crate reports database state for a validated migration manifest. It
//! never acquires the migration writer lock, executes migration SQL, repairs a
//! journal, or changes startup authority. Node remains the only migration
//! writer until a later, separately reviewed integration replaces it.

use rudder_migration_core::MigrationManifest;
use rudder_migration_history_core::{
    MigrationHistoryError, MigrationHistoryPreflight, MigrationHistoryReason,
    MigrationHistorySnapshot, reconcile_migration_history,
};
use rudder_migration_history_postgres::{
    MigrationHistoryPostgresError, begin_read_only_transaction, read_snapshot_in_transaction,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use thiserror::Error;

/// States returned by the read-only database preflight.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationPreflightStatus {
    Bootstrap,
    UnsafeLegacy,
    Pending,
    Mismatch,
    MissingCoreSchema,
    Current,
}

/// Database-shape facts collected in the same snapshot as migration history.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreflightDatabaseState {
    pub table_count: u64,
    pub core_schema_present: bool,
    pub organizations_table_present: bool,
}

/// Complete read-only preflight result for one manifest and database snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreflightReport {
    pub status: MigrationPreflightStatus,
    pub table_count: u64,
    pub journal_present: bool,
    pub journal_schema: Option<String>,
    pub core_schema_present: bool,
    pub organizations_table_present: bool,
    pub history: MigrationHistoryPreflight,
    pub diagnostics: Vec<String>,
}

/// Errors returned by the read-only preflight boundary.
#[derive(Debug, Error)]
pub enum MigrationPreflightError {
    #[error("migration history postgres read failed: {0}")]
    HistoryPostgres(#[from] MigrationHistoryPostgresError),
    #[error("migration history reconciliation failed: {0}")]
    History(#[from] MigrationHistoryError),
    #[error("migration preflight database read failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration preflight table count is invalid: {0}")]
    InvalidTableCount(i64),
}

/// Pool-backed read-only migration preflight.
#[derive(Clone)]
pub struct MigrationPreflightService {
    pool: PgPool,
}

impl MigrationPreflightService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self::new(pool)
    }

    /// Reads history and core-schema facts from one repeatable-read snapshot.
    pub async fn preflight(
        &self,
        manifest: &MigrationManifest,
    ) -> Result<MigrationPreflightReport, MigrationPreflightError> {
        let mut transaction = begin_read_only_transaction(&self.pool).await?;
        let result = preflight_in_transaction(&mut transaction, manifest).await;
        match result {
            Ok(report) => {
                transaction.commit().await?;
                Ok(report)
            }
            Err(error) => {
                let _ = transaction.rollback().await;
                Err(error)
            }
        }
    }
}

async fn preflight_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    manifest: &MigrationManifest,
) -> Result<MigrationPreflightReport, MigrationPreflightError> {
    let snapshot = read_snapshot_in_transaction(transaction).await?;
    let database = read_database_state(transaction).await?;
    let history = reconcile_migration_history(manifest, &snapshot)?;
    Ok(classify_preflight(&snapshot, history, database))
}

async fn read_database_state(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<MigrationPreflightDatabaseState, MigrationPreflightError> {
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
    .fetch_one(&mut **transaction)
    .await?;
    let table_count = row.try_get::<i64, _>("table_count")?;
    let table_count = u64::try_from(table_count)
        .map_err(|_| MigrationPreflightError::InvalidTableCount(table_count))?;
    Ok(MigrationPreflightDatabaseState {
        table_count,
        core_schema_present: row.try_get("core_schema_present")?,
        organizations_table_present: row.try_get("organizations_table_present")?,
    })
}

/// Classifies a history snapshot and database-shape facts without I/O.
pub fn classify_preflight(
    snapshot: &MigrationHistorySnapshot,
    history: MigrationHistoryPreflight,
    database: MigrationPreflightDatabaseState,
) -> MigrationPreflightReport {
    let journal_present = snapshot.table_schema.is_some();
    let status = if !database.core_schema_present {
        MigrationPreflightStatus::MissingCoreSchema
    } else if !journal_present {
        if database.table_count == 0 {
            MigrationPreflightStatus::Bootstrap
        } else {
            MigrationPreflightStatus::UnsafeLegacy
        }
    } else {
        match history.reason {
            MigrationHistoryReason::ManifestMatch => {
                if database.organizations_table_present {
                    MigrationPreflightStatus::Current
                } else {
                    MigrationPreflightStatus::MissingCoreSchema
                }
            }
            MigrationHistoryReason::PendingMigrations | MigrationHistoryReason::EmptyHistory => {
                MigrationPreflightStatus::Pending
            }
            MigrationHistoryReason::ManifestMismatch
            | MigrationHistoryReason::MigrationJournalInvalid
            | MigrationHistoryReason::MigrationJournalMissing => MigrationPreflightStatus::Mismatch,
        }
    };

    let mut diagnostics = history.diagnostics.clone();
    if !database.core_schema_present {
        diagnostics.push("public core schema is missing".to_owned());
    }
    if !database.organizations_table_present {
        diagnostics.push("core organizations table is missing".to_owned());
    }
    if !journal_present && database.table_count > 0 {
        diagnostics.push("database has application tables but no migration journal".to_owned());
    }
    diagnostics.sort();
    diagnostics.dedup();

    MigrationPreflightReport {
        status,
        table_count: database.table_count,
        journal_present,
        journal_schema: snapshot.table_schema.clone(),
        core_schema_present: database.core_schema_present,
        organizations_table_present: database.organizations_table_present,
        history,
        diagnostics,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rudder_migration_history_core::{
        MigrationHistoryColumns, MigrationHistoryRow, MigrationHistoryStatus,
    };

    fn snapshot(table_schema: Option<&str>) -> MigrationHistorySnapshot {
        MigrationHistorySnapshot {
            table_schema: table_schema.map(str::to_owned),
            columns: MigrationHistoryColumns {
                id: table_schema.is_some(),
                ..Default::default()
            },
            rows: Vec::new(),
        }
    }

    fn history(reason: MigrationHistoryReason) -> MigrationHistoryPreflight {
        MigrationHistoryPreflight {
            status: if reason == MigrationHistoryReason::ManifestMatch {
                MigrationHistoryStatus::UpToDate
            } else {
                MigrationHistoryStatus::NeedsMigrations
            },
            reason,
            manifest_fingerprint: "test".to_owned(),
            migration_table_schema: None,
            journal_entry_count: 0,
            applied_migrations: Vec::new(),
            pending_migrations: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn database(table_count: u64, organizations: bool) -> MigrationPreflightDatabaseState {
        MigrationPreflightDatabaseState {
            table_count,
            core_schema_present: true,
            organizations_table_present: organizations,
        }
    }

    #[test]
    fn empty_database_is_bootstrap() {
        let report = classify_preflight(
            &snapshot(None),
            history(MigrationHistoryReason::MigrationJournalMissing),
            database(0, false),
        );
        assert_eq!(report.status, MigrationPreflightStatus::Bootstrap);
        assert!(!report.journal_present);
    }

    #[test]
    fn non_empty_database_without_journal_is_unsafe_legacy() {
        let report = classify_preflight(
            &snapshot(None),
            history(MigrationHistoryReason::MigrationJournalMissing),
            database(2, false),
        );
        assert_eq!(report.status, MigrationPreflightStatus::UnsafeLegacy);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|item| item.contains("no migration journal"))
        );
    }

    #[test]
    fn pending_history_is_pending() {
        let report = classify_preflight(
            &snapshot(Some("drizzle")),
            history(MigrationHistoryReason::PendingMigrations),
            database(2, true),
        );
        assert_eq!(report.status, MigrationPreflightStatus::Pending);
    }

    #[test]
    fn current_history_without_organizations_is_missing_core_schema() {
        let report = classify_preflight(
            &snapshot(Some("drizzle")),
            history(MigrationHistoryReason::ManifestMatch),
            database(2, false),
        );
        assert_eq!(report.status, MigrationPreflightStatus::MissingCoreSchema);
        assert!(!report.organizations_table_present);
    }

    #[test]
    fn current_history_with_organizations_is_current() {
        let report = classify_preflight(
            &snapshot(Some("drizzle")),
            history(MigrationHistoryReason::ManifestMatch),
            database(2, true),
        );
        assert_eq!(report.status, MigrationPreflightStatus::Current);
        assert!(report.core_schema_present);
    }

    #[test]
    fn duplicate_or_unknown_history_remains_mismatch() {
        let mut mismatch = history(MigrationHistoryReason::ManifestMismatch);
        mismatch.diagnostics.push("duplicate history".to_owned());
        let report = classify_preflight(&snapshot(Some("drizzle")), mismatch, database(2, true));
        assert_eq!(report.status, MigrationPreflightStatus::Mismatch);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|item| item == "duplicate history")
        );
    }

    #[test]
    fn rows_are_not_rewritten_by_classification() {
        let mut snapshot = snapshot(Some("drizzle"));
        snapshot.rows.push(MigrationHistoryRow {
            id: 1,
            name: None,
            hash: Some("unknown".to_owned()),
            created_at: Some(1),
        });
        let report = classify_preflight(
            &snapshot,
            history(MigrationHistoryReason::ManifestMismatch),
            database(2, true),
        );
        assert_eq!(report.history.journal_entry_count, 0);
        assert_eq!(snapshot.rows.len(), 1);
    }
}
