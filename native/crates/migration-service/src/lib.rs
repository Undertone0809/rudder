//! Private PostgreSQL migration runner for the canonical Drizzle journal.
//!
//! This crate deliberately exposes no HTTP or arbitrary-SQL interface. The
//! caller supplies a validated manifest directory and, for a non-empty
//! database, a recovery receipt produced by the backup owner.

use rudder_migration_core::{MigrationEntry, MigrationManifest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor, PgConnection, Row};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

pub const NODE_ADVISORY_LOCK_NAME: &str = "rudder:database-migrations";
const HISTORY_TABLE: &str = "__drizzle_migrations";
const BREAKPOINT: &str = "--> statement-breakpoint";

#[derive(Debug, Error)]
pub enum MigrationServiceError {
    #[error("migration assets are invalid: {0}")]
    InvalidManifest(String),
    #[error("database has application tables but no migration journal")]
    UnsafeLegacyDatabase,
    #[error("migration history is incompatible: {0}")]
    IncompatibleHistory(String),
    #[error("recovery receipt is missing or does not bind this database and migration state")]
    InvalidRecoveryReceipt,
    #[error("migration file changed after validation: {0}")]
    AssetChanged(String),
    #[error("migration {migration} failed: {source}")]
    Apply {
        migration: String,
        #[source]
        source: sqlx::Error,
    },
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RecoveryReceipt {
    pub database_identity: String,
    pub manifest_fingerprint: String,
    pub history_fingerprint: String,
    pub artifact_path: PathBuf,
    pub includes_migration_journal: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationState {
    Bootstrap {
        pending: Vec<String>,
    },
    Pending {
        applied: usize,
        pending: Vec<String>,
    },
    Current {
        applied: usize,
    },
    UnsafeLegacy {
        table_count: i64,
    },
    MissingCoreSchema,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunReport {
    pub before: MigrationState,
    pub applied: Vec<String>,
    pub after: MigrationState,
    pub manifest_fingerprint: String,
}

pub struct MigrationService {
    migrations_dir: PathBuf,
    manifest: MigrationManifest,
}

impl MigrationService {
    pub fn new(
        migrations_dir: impl Into<PathBuf>,
        manifest: MigrationManifest,
    ) -> Result<Self, MigrationServiceError> {
        let integrity = manifest.validate_integrity();
        if !integrity.valid {
            return Err(MigrationServiceError::InvalidManifest(
                integrity.errors.join("; "),
            ));
        }
        Ok(Self {
            migrations_dir: migrations_dir.into(),
            manifest,
        })
    }

    pub async fn connect_and_preflight(
        &self,
        url: &str,
    ) -> Result<MigrationState, MigrationServiceError> {
        let mut connection = PgConnection::connect(url).await?;
        self.preflight(&mut connection).await
    }

    /// Runs pending migrations while holding the same two-key session advisory
    /// lock as Node. Dropping/cancelling this future drops the dedicated
    /// connection, releasing the lock; each migration transaction rolls back.
    pub async fn run(
        &self,
        url: &str,
        recovery: Option<&RecoveryReceipt>,
    ) -> Result<RunReport, MigrationServiceError> {
        let mut connection = PgConnection::connect(url).await?;
        sqlx::query("SELECT pg_advisory_lock(hashtext(current_database()), hashtext($1))")
            .bind(NODE_ADVISORY_LOCK_NAME)
            .execute(&mut connection)
            .await?;
        let result = self.run_locked(&mut connection, recovery).await;
        let unlock =
            sqlx::query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))")
                .bind(NODE_ADVISORY_LOCK_NAME)
                .execute(&mut connection)
                .await;
        match (result, unlock) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error.into()),
            (Ok(report), Ok(_)) => Ok(report),
        }
    }

    async fn run_locked(
        &self,
        connection: &mut PgConnection,
        recovery: Option<&RecoveryReceipt>,
    ) -> Result<RunReport, MigrationServiceError> {
        let before = self.preflight(connection).await?;
        let pending = match &before {
            MigrationState::Bootstrap { pending } | MigrationState::Pending { pending, .. } => {
                pending.clone()
            }
            MigrationState::Current { .. } => {
                return Ok(RunReport {
                    before: before.clone(),
                    applied: vec![],
                    after: before,
                    manifest_fingerprint: self.manifest.fingerprint.clone(),
                });
            }
            MigrationState::UnsafeLegacy { .. } => {
                return Err(MigrationServiceError::UnsafeLegacyDatabase);
            }
            MigrationState::MissingCoreSchema => {
                return Err(MigrationServiceError::IncompatibleHistory(
                    "journal is current but organizations is missing".into(),
                ));
            }
        };
        let snapshot = inspect(connection, &self.manifest).await?;
        if !matches!(before, MigrationState::Bootstrap { .. }) {
            validate_recovery(recovery, &snapshot, &self.manifest.fingerprint)?;
        }
        ensure_history(connection).await?;
        let mut applied = Vec::new();
        for name in pending {
            let entry = self
                .manifest
                .entries
                .iter()
                .find(|entry| entry.file_name == name)
                .expect("pending entries originate in manifest");
            self.apply_entry(connection, entry).await?;
            applied.push(name);
        }
        let after = self.preflight(connection).await?;
        if !matches!(after, MigrationState::Current { .. }) {
            return Err(MigrationServiceError::IncompatibleHistory(
                "database is not current after execution".into(),
            ));
        }
        Ok(RunReport {
            before,
            applied,
            after,
            manifest_fingerprint: self.manifest.fingerprint.clone(),
        })
    }

    async fn apply_entry(
        &self,
        connection: &mut PgConnection,
        entry: &MigrationEntry,
    ) -> Result<(), MigrationServiceError> {
        let bytes = std::fs::read(self.migrations_dir.join(&entry.file_name))?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != entry.sha256 {
            return Err(MigrationServiceError::AssetChanged(entry.file_name.clone()));
        }
        let sql = String::from_utf8(bytes)
            .map_err(|_| MigrationServiceError::AssetChanged(entry.file_name.clone()))?;
        let mut transaction = connection.begin().await?;
        for statement in sql
            .split(BREAKPOINT)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            transaction.execute(statement).await.map_err(|source| {
                MigrationServiceError::Apply {
                    migration: entry.file_name.clone(),
                    source,
                }
            })?;
        }
        let created_at = entry
            .journal_entry
            .as_ref()
            .map_or_else(now_millis, |journal| {
                journal.when.min(i64::MAX as u64) as i64
            });
        record_history(&mut transaction, entry, created_at)
            .await
            .map_err(|source| MigrationServiceError::Apply {
                migration: entry.file_name.clone(),
                source,
            })?;
        transaction
            .commit()
            .await
            .map_err(|source| MigrationServiceError::Apply {
                migration: entry.file_name.clone(),
                source,
            })
    }

    async fn preflight(
        &self,
        connection: &mut PgConnection,
    ) -> Result<MigrationState, MigrationServiceError> {
        let snapshot = inspect(connection, &self.manifest).await?;
        if !snapshot.has_history {
            return Ok(if snapshot.table_count == 0 {
                MigrationState::Bootstrap {
                    pending: self.manifest.sql_files.clone(),
                }
            } else {
                MigrationState::UnsafeLegacy {
                    table_count: snapshot.table_count,
                }
            });
        }
        if snapshot.pending.is_empty() {
            return Ok(if snapshot.has_organizations {
                MigrationState::Current {
                    applied: snapshot.applied,
                }
            } else {
                MigrationState::MissingCoreSchema
            });
        }
        Ok(MigrationState::Pending {
            applied: snapshot.applied,
            pending: snapshot.pending,
        })
    }
}

#[derive(Debug)]
struct Snapshot {
    table_count: i64,
    has_history: bool,
    has_organizations: bool,
    applied: usize,
    pending: Vec<String>,
    database_identity: String,
    history_fingerprint: String,
}

async fn inspect(
    connection: &mut PgConnection,
    manifest: &MigrationManifest,
) -> Result<Snapshot, MigrationServiceError> {
    let identity: (String, i32) = sqlx::query_as(
        "SELECT current_database(), oid::int FROM pg_database WHERE datname=current_database()",
    )
    .fetch_one(&mut *connection)
    .await?;
    let table_count: i64 = sqlx::query_scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'").fetch_one(&mut *connection).await?;
    let schema: Option<String> = sqlx::query_scalar("SELECT table_schema FROM information_schema.tables WHERE table_name=$1 AND table_schema IN ('drizzle','public') ORDER BY CASE table_schema WHEN 'drizzle' THEN 0 ELSE 1 END LIMIT 1")
        .bind(HISTORY_TABLE).fetch_optional(&mut *connection).await?;
    let has_organizations: bool =
        sqlx::query_scalar("SELECT to_regclass('public.organizations') IS NOT NULL")
            .fetch_one(&mut *connection)
            .await?;
    let Some(schema) = schema else {
        return Ok(Snapshot {
            table_count,
            has_history: false,
            has_organizations,
            applied: 0,
            pending: manifest.sql_files.clone(),
            database_identity: format!("{}:{}", identity.0, identity.1),
            history_fingerprint: hash_lines(&[]),
        });
    };
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    )
    .bind(&schema)
    .bind(HISTORY_TABLE)
    .fetch_all(&mut *connection)
    .await?;
    if !columns.iter().any(|column| column == "created_at")
        || !columns
            .iter()
            .any(|column| column == "hash" || column == "name")
    {
        return Err(MigrationServiceError::IncompatibleHistory(
            "journal requires created_at and hash or name".into(),
        ));
    }
    let name = if columns.iter().any(|column| column == "name") {
        "COALESCE(name,'')"
    } else {
        "''::text"
    };
    let hash = if columns.iter().any(|column| column == "hash") {
        "COALESCE(hash,'')"
    } else {
        "''::text"
    };
    let order = if columns.iter().any(|column| column == "id") {
        "created_at, id"
    } else {
        "created_at"
    };
    let query = format!(
        "SELECT {name}, {hash}, created_at FROM {schema}.__drizzle_migrations ORDER BY {order}"
    );
    let rows = sqlx::query(&query).fetch_all(&mut *connection).await?;
    let mut lines = Vec::new();
    let mut applied = Vec::new();
    for row in rows {
        let name: String = row.try_get(0)?;
        let hash: String = row.try_get(1)?;
        let created: i64 = row.try_get(2)?;
        lines.push(format!("{name}\0{hash}\0{created}"));
        applied.push((name, hash));
    }
    let mut pending = Vec::new();
    for entry in &manifest.entries {
        let matches: Vec<_> = applied
            .iter()
            .filter(|(name, hash)| name == &entry.file_name || hash == &entry.sha256)
            .collect();
        if matches.is_empty() {
            pending.push(entry.file_name.clone());
        } else if matches.iter().any(|(name, hash)| {
            (!name.is_empty() && name != &entry.file_name)
                || (!hash.is_empty() && hash != &entry.sha256)
        }) {
            return Err(MigrationServiceError::IncompatibleHistory(format!(
                "identity mismatch for {}",
                entry.file_name
            )));
        }
    }
    Ok(Snapshot {
        table_count,
        has_history: true,
        has_organizations,
        applied: applied.len(),
        pending,
        database_identity: format!("{}:{}", identity.0, identity.1),
        history_fingerprint: hash_lines(&lines),
    })
}

async fn ensure_history(connection: &mut PgConnection) -> Result<(), sqlx::Error> {
    connection
        .execute("CREATE SCHEMA IF NOT EXISTS drizzle")
        .await?;
    connection.execute("CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text)").await?;
    Ok(())
}

async fn record_history(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    entry: &MigrationEntry,
    created_at: i64,
) -> Result<(), sqlx::Error> {
    let schema: String = sqlx::query_scalar("SELECT table_schema FROM information_schema.tables WHERE table_name=$1 AND table_schema IN ('drizzle','public') ORDER BY CASE table_schema WHEN 'drizzle' THEN 0 ELSE 1 END LIMIT 1")
        .bind(HISTORY_TABLE).fetch_one(&mut **transaction).await?;
    let columns: Vec<String> = sqlx::query_scalar("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2")
        .bind(&schema).bind(HISTORY_TABLE).fetch_all(&mut **transaction).await?;
    let has_hash = columns.iter().any(|column| column == "hash");
    let has_name = columns.iter().any(|column| column == "name");
    let table = format!("{schema}.{HISTORY_TABLE}");
    let timestamp =
        format!("GREATEST($1, COALESCE((SELECT max(created_at) + 1 FROM {table}), $1))");
    let query = match (has_hash, has_name) {
        (true, true) => {
            format!("INSERT INTO {table} (created_at,hash,name) VALUES ({timestamp},$2,$3)")
        }
        (true, false) => format!("INSERT INTO {table} (created_at,hash) VALUES ({timestamp},$2)"),
        (false, true) => format!("INSERT INTO {table} (created_at,name) VALUES ({timestamp},$2)"),
        (false, false) => {
            return Err(sqlx::Error::Protocol(
                "migration journal has neither hash nor name".into(),
            ));
        }
    };
    let mut statement = sqlx::query(&query).bind(created_at);
    statement = statement.bind(if has_hash {
        &entry.sha256
    } else {
        &entry.file_name
    });
    if has_hash && has_name {
        statement = statement.bind(&entry.file_name);
    }
    statement.execute(&mut **transaction).await?;
    Ok(())
}

fn validate_recovery(
    receipt: Option<&RecoveryReceipt>,
    snapshot: &Snapshot,
    manifest: &str,
) -> Result<(), MigrationServiceError> {
    let valid = receipt.is_some_and(|r| {
        r.includes_migration_journal
            && !r.artifact_path.as_os_str().is_empty()
            && r.artifact_path.is_absolute()
            && r.database_identity == snapshot.database_identity
            && r.manifest_fingerprint == manifest
            && r.history_fingerprint == snapshot.history_fingerprint
    });
    if valid {
        Ok(())
    } else {
        Err(MigrationServiceError::InvalidRecoveryReceipt)
    }
}

fn hash_lines(lines: &[String]) -> String {
    let mut h = Sha256::new();
    for line in lines {
        h.update((line.len() as u64).to_be_bytes());
        h.update(line.as_bytes());
    }
    format!("{:x}", h.finalize())
}
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// Creates the receipt payload that a backup implementation signs/stores with
/// its artifact. It is intentionally read-only and cannot assert artifact creation.
pub async fn recovery_binding(
    url: &str,
    manifest: &MigrationManifest,
    artifact_path: &Path,
) -> Result<RecoveryReceipt, MigrationServiceError> {
    let mut connection = PgConnection::connect(url).await?;
    let snapshot = inspect(&mut connection, manifest).await?;
    Ok(RecoveryReceipt {
        database_identity: snapshot.database_identity,
        manifest_fingerprint: manifest.fingerprint.clone(),
        history_fingerprint: snapshot.history_fingerprint,
        artifact_path: artifact_path.to_owned(),
        includes_migration_journal: snapshot.has_history,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_fingerprint_is_order_and_boundary_sensitive() {
        assert_ne!(
            hash_lines(&["ab".into(), "c".into()]),
            hash_lines(&["a".into(), "bc".into()])
        );
        assert_ne!(
            hash_lines(&["a".into(), "b".into()]),
            hash_lines(&["b".into(), "a".into()])
        );
    }
    #[test]
    fn node_lock_identity_is_exact() {
        assert_eq!(NODE_ADVISORY_LOCK_NAME, "rudder:database-migrations");
    }
}
