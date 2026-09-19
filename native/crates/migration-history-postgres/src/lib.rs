//! Read-only PostgreSQL/SQLx adapter for migration history.
//!
//! The adapter executes only the SELECT statements owned by
//! `rudder-migration-history-core::query`. It discovers the legacy Drizzle
//! journal, reads its available columns, and maps rows into the core snapshot
//! without acquiring a lock or changing database state.

use rudder_migration_core::MigrationManifest;
use rudder_migration_history_core::{
    MIGRATION_HISTORY_TABLE_NAME, MigrationHistoryColumns, MigrationHistoryPreflight,
    MigrationHistoryRow, MigrationHistorySnapshot,
    query::{self, QueryContractError},
    reconcile_migration_history,
};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction, TypeInfo, ValueRef, postgres::PgRow};
use thiserror::Error;

pub const MAX_MIGRATION_HISTORY_ROWS: usize = 4_096;
const MAX_MIGRATION_HISTORY_TEXT_BYTES: usize = 256 * 1024;
pub const READ_ONLY_TRANSACTION: &str =
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";

/// Errors returned while reading or mapping migration history.
#[derive(Debug, Error)]
pub enum MigrationHistoryPostgresError {
    #[error("migration history database read failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration history query contract failed: {0}")]
    QueryContract(#[from] QueryContractError),
    #[error("migration history row decode failed for {column}: {source}")]
    RowDecode {
        column: &'static str,
        #[source]
        source: sqlx::Error,
    },
    #[error("migration history has more than {limit} rows")]
    RowLimitExceeded { limit: usize },
    #[error("migration history row conversion failed for {column}: {reason}")]
    Conversion {
        column: &'static str,
        reason: String,
    },
    #[error(transparent)]
    Reconciliation(#[from] rudder_migration_history_core::MigrationHistoryError),
}

/// Pool-backed read-only migration history access.
#[derive(Clone)]
pub struct MigrationHistoryPostgres {
    pool: PgPool,
}

/// Alias for callers that prefer the adapter terminology.
pub type MigrationHistoryPostgresAdapter = MigrationHistoryPostgres;

impl MigrationHistoryPostgres {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self::new(pool)
    }

    /// Reads one migration-history snapshot using only the core SELECT contract.
    pub async fn read_snapshot(
        &self,
    ) -> Result<MigrationHistorySnapshot, MigrationHistoryPostgresError> {
        read_snapshot_from_pool(&self.pool).await
    }

    /// Reads and reconciles migration history without repairing or executing it.
    pub async fn preflight(
        &self,
        manifest: &MigrationManifest,
    ) -> Result<MigrationHistoryPreflight, MigrationHistoryPostgresError> {
        let snapshot = self.read_snapshot().await?;
        Ok(reconcile_migration_history(manifest, &snapshot)?)
    }
}

/// Reads one migration-history snapshot using a PostgreSQL pool.
pub async fn read_snapshot_from_pool(
    pool: &PgPool,
) -> Result<MigrationHistorySnapshot, MigrationHistoryPostgresError> {
    let mut transaction = begin_read_only_transaction(pool).await?;
    let result = read_snapshot_in_transaction(&mut transaction).await;
    match result {
        Ok(snapshot) => {
            transaction.commit().await?;
            Ok(snapshot)
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
    }
}

/// Starts the transaction contract shared by migration-history preflight readers.
pub async fn begin_read_only_transaction(
    pool: &PgPool,
) -> Result<Transaction<'_, Postgres>, MigrationHistoryPostgresError> {
    let mut transaction = pool.begin().await?;
    if let Err(error) = sqlx::query(READ_ONLY_TRANSACTION)
        .execute(&mut *transaction)
        .await
    {
        let _ = transaction.rollback().await;
        return Err(MigrationHistoryPostgresError::Database(error));
    }
    Ok(transaction)
}

/// Reads a migration-history snapshot inside an already configured transaction.
///
/// The caller must start the transaction with [`begin_read_only_transaction`]
/// so all sibling preflight queries observe the same repeatable-read snapshot.
pub async fn read_snapshot_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<MigrationHistorySnapshot, MigrationHistoryPostgresError> {
    let connection: &mut PgConnection = transaction;
    let schema = discover_schema(connection).await?;
    let Some(schema) = schema else {
        return Ok(MigrationHistorySnapshot {
            table_schema: None,
            columns: MigrationHistoryColumns::default(),
            rows: Vec::new(),
        });
    };

    let columns = discover_columns(connection, &schema).await?;
    if !columns.id {
        return Ok(MigrationHistorySnapshot {
            table_schema: Some(schema),
            columns,
            rows: Vec::new(),
        });
    }

    for (present, column) in [(columns.name, "name"), (columns.hash, "hash")] {
        if !present {
            continue;
        }
        let statement = query::migration_history_text_bound_select(&schema, column)?;
        if sqlx::query(&statement)
            .bind(MAX_MIGRATION_HISTORY_TEXT_BYTES as i64)
            .fetch_optional(&mut *connection)
            .await?
            .is_some()
        {
            return Err(MigrationHistoryPostgresError::Conversion {
                column,
                reason: format!(
                    "text value exceeds {} bytes",
                    MAX_MIGRATION_HISTORY_TEXT_BYTES
                ),
            });
        }
    }

    let statement = query::migration_history_rows_select(&schema, columns)?;
    let rows = sqlx::query(&statement)
        .bind((MAX_MIGRATION_HISTORY_ROWS + 1) as i64)
        .fetch_all(&mut *connection)
        .await?;
    if rows.len() > MAX_MIGRATION_HISTORY_ROWS {
        return Err(MigrationHistoryPostgresError::RowLimitExceeded {
            limit: MAX_MIGRATION_HISTORY_ROWS,
        });
    }
    let rows = rows
        .iter()
        .map(|row| map_row(row, columns))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(MigrationHistorySnapshot {
        table_schema: Some(schema),
        columns,
        rows,
    })
}

async fn discover_schema(
    connection: &mut PgConnection,
) -> Result<Option<String>, MigrationHistoryPostgresError> {
    let row = sqlx::query(query::DISCOVER_SCHEMA_SELECT)
        .bind(MIGRATION_HISTORY_TABLE_NAME)
        .fetch_optional(&mut *connection)
        .await?;
    row.map(|row| {
        row.try_get::<String, _>("schema_name").map_err(|source| {
            MigrationHistoryPostgresError::RowDecode {
                column: "schema_name",
                source,
            }
        })
    })
    .transpose()
}

async fn discover_columns(
    connection: &mut PgConnection,
    schema: &str,
) -> Result<MigrationHistoryColumns, MigrationHistoryPostgresError> {
    let rows = sqlx::query(query::DISCOVER_COLUMNS_SELECT)
        .bind(schema)
        .bind(MIGRATION_HISTORY_TABLE_NAME)
        .fetch_all(&mut *connection)
        .await?;
    let names = rows
        .iter()
        .map(|row| {
            row.try_get::<String, _>("column_name").map_err(|source| {
                MigrationHistoryPostgresError::RowDecode {
                    column: "column_name",
                    source,
                }
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns_from_names(names))
}

fn columns_from_names<I, S>(names: I) -> MigrationHistoryColumns
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut columns = MigrationHistoryColumns::default();
    for name in names {
        match name.as_ref() {
            "id" => columns.id = true,
            "name" => columns.name = true,
            "hash" => columns.hash = true,
            "created_at" => columns.created_at = true,
            _ => {}
        }
    }
    columns
}

fn map_row(
    row: &PgRow,
    columns: MigrationHistoryColumns,
) -> Result<MigrationHistoryRow, MigrationHistoryPostgresError> {
    let values = RawMigrationHistoryRow {
        id: decode_integer(row, "id")?,
        name: columns
            .name
            .then(|| decode_optional_text(row, "name"))
            .transpose()?
            .flatten(),
        hash: columns
            .hash
            .then(|| decode_optional_text(row, "hash"))
            .transpose()?
            .flatten(),
        created_at: columns
            .created_at
            .then(|| decode_optional_integer(row, "created_at"))
            .transpose()?
            .flatten(),
    };
    map_raw_row(values)
}

#[derive(Debug, Eq, PartialEq)]
struct RawMigrationHistoryRow {
    id: i64,
    name: Option<String>,
    hash: Option<String>,
    created_at: Option<i64>,
}

fn map_raw_row(
    row: RawMigrationHistoryRow,
) -> Result<MigrationHistoryRow, MigrationHistoryPostgresError> {
    let id = u64::try_from(row.id).map_err(|_| MigrationHistoryPostgresError::Conversion {
        column: "id",
        reason: format!(
            "value {} is not representable as an unsigned integer",
            row.id
        ),
    })?;
    Ok(MigrationHistoryRow {
        id,
        name: row.name,
        hash: row.hash,
        created_at: row.created_at,
    })
}

fn decode_integer(row: &PgRow, column: &'static str) -> Result<i64, MigrationHistoryPostgresError> {
    let (type_name, is_null) = column_type(row, column)?;
    if is_null {
        return Err(MigrationHistoryPostgresError::Conversion {
            column,
            reason: "NULL is not allowed".to_owned(),
        });
    }
    match type_name.as_str() {
        "int2" => row
            .try_get::<i16, _>(column)
            .map(i64::from)
            .map_err(|source| row_decode(column, source)),
        "int4" => row
            .try_get::<i32, _>(column)
            .map(i64::from)
            .map_err(|source| row_decode(column, source)),
        "int8" => row
            .try_get::<i64, _>(column)
            .map_err(|source| row_decode(column, source)),
        _ => Err(MigrationHistoryPostgresError::Conversion {
            column,
            reason: format!("unsupported PostgreSQL type {type_name}"),
        }),
    }
}

fn decode_optional_integer(
    row: &PgRow,
    column: &'static str,
) -> Result<Option<i64>, MigrationHistoryPostgresError> {
    let (type_name, is_null) = column_type(row, column)?;
    let value = match type_name.as_str() {
        "int2" => row
            .try_get::<Option<i16>, _>(column)
            .map(|value| value.map(i64::from))
            .map_err(|source| row_decode(column, source))?,
        "int4" => row
            .try_get::<Option<i32>, _>(column)
            .map(|value| value.map(i64::from))
            .map_err(|source| row_decode(column, source))?,
        "int8" => row
            .try_get::<Option<i64>, _>(column)
            .map_err(|source| row_decode(column, source))?,
        _ => {
            return Err(MigrationHistoryPostgresError::Conversion {
                column,
                reason: format!("unsupported PostgreSQL type {type_name}"),
            });
        }
    };
    Ok(if is_null { None } else { value })
}

fn decode_optional_text(
    row: &PgRow,
    column: &'static str,
) -> Result<Option<String>, MigrationHistoryPostgresError> {
    let (type_name, is_null) = column_type(row, column)?;
    if !matches!(
        type_name.as_str(),
        "text" | "varchar" | "bpchar" | "name" | "citext"
    ) {
        return Err(MigrationHistoryPostgresError::Conversion {
            column,
            reason: format!("unsupported PostgreSQL type {type_name}"),
        });
    }
    if is_null {
        return Ok(None);
    }
    let value = row
        .try_get::<String, _>(column)
        .map_err(|source| row_decode(column, source))?;
    if value.len() > MAX_MIGRATION_HISTORY_TEXT_BYTES {
        return Err(MigrationHistoryPostgresError::Conversion {
            column,
            reason: format!(
                "text value exceeds {} bytes",
                MAX_MIGRATION_HISTORY_TEXT_BYTES
            ),
        });
    }
    Ok(Some(value))
}

fn column_type(
    row: &PgRow,
    column: &'static str,
) -> Result<(String, bool), MigrationHistoryPostgresError> {
    let value = row
        .try_get_raw(column)
        .map_err(|source| row_decode(column, source))?;
    Ok((
        value.type_info().name().to_ascii_lowercase(),
        value.is_null(),
    ))
}

fn row_decode(column: &'static str, source: sqlx::Error) -> MigrationHistoryPostgresError {
    MigrationHistoryPostgresError::RowDecode { column, source }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rudder_migration_history_core::MigrationHistoryColumns;

    #[test]
    fn discovers_only_core_columns() {
        let columns = columns_from_names(["id", "name", "hash", "created_at", "ignored"]);
        assert_eq!(
            columns,
            MigrationHistoryColumns {
                id: true,
                name: true,
                hash: true,
                created_at: true,
            }
        );
    }

    #[test]
    fn missing_columns_are_preserved_as_absent_values() {
        let columns = columns_from_names(["id", "hash"]);
        let mapped = map_raw_row(RawMigrationHistoryRow {
            id: 7,
            name: None,
            hash: Some("hash".to_owned()),
            created_at: None,
        })
        .unwrap();
        assert_eq!(mapped.id, 7);
        assert_eq!(mapped.name, None);
        assert_eq!(mapped.hash.as_deref(), Some("hash"));
        assert_eq!(mapped.created_at, None);
        assert!(columns.id);
        assert!(!columns.name);
        assert!(columns.hash);
        assert!(!columns.created_at);
    }

    #[test]
    fn row_mapping_rejects_negative_ids() {
        let error = map_raw_row(RawMigrationHistoryRow {
            id: -1,
            name: None,
            hash: None,
            created_at: None,
        })
        .unwrap_err();
        assert!(matches!(
            error,
            MigrationHistoryPostgresError::Conversion { column: "id", .. }
        ));
    }

    #[test]
    fn row_query_is_the_core_select_contract() {
        let statement = query::migration_history_rows_select(
            "drizzle",
            MigrationHistoryColumns {
                id: true,
                name: true,
                hash: true,
                created_at: true,
            },
        )
        .unwrap();
        assert_eq!(
            statement,
            "SELECT \"id\", \"name\", \"hash\", \"created_at\" FROM \"drizzle\".\"__drizzle_migrations\" ORDER BY \"id\" LIMIT $1"
        );
        let normalized = statement.to_ascii_uppercase();
        assert!(normalized.starts_with("SELECT"));
        for mutation in ["INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "TRUNCATE"] {
            assert!(!normalized.contains(mutation));
        }
    }

    #[test]
    fn missing_id_is_left_for_the_core_contract_to_classify() {
        let columns = columns_from_names(["hash", "created_at"]);
        assert!(!columns.id);
        assert!(matches!(
            query::migration_history_rows_select("drizzle", columns),
            Err(QueryContractError::MissingIdColumn)
        ));
    }
}
