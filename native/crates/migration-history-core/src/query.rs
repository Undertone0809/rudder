//! SELECT-only query contract for a future PostgreSQL/SQLx adapter.
//!
//! The contract stops at [`MigrationHistorySnapshot`]. It intentionally does
//! not own a pool, transaction, lock, migration runner, or recovery policy.

use crate::{MIGRATION_HISTORY_TABLE_NAME, MigrationHistoryColumns, MigrationHistorySnapshot};
use thiserror::Error;

pub const DISCOVER_SCHEMA_SELECT: &str = r#"
SELECT n.nspname AS schema_name
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relname = $1
  AND c.relkind = 'r'
ORDER BY CASE n.nspname WHEN 'drizzle' THEN 0 WHEN 'public' THEN 1 ELSE 2 END, n.nspname
"#;

pub const DISCOVER_COLUMNS_SELECT: &str = r#"
SELECT column_name
FROM information_schema.columns
WHERE table_schema = $1
  AND table_name = $2
ORDER BY ordinal_position
"#;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum QueryContractError {
    #[error("unsafe-identifier: {0}")]
    UnsafeIdentifier(String),
    #[error("migration history table requires an id column")]
    MissingIdColumn,
}

pub trait MigrationHistorySelectAdapter {
    type Error;

    fn read_snapshot(&self) -> Result<MigrationHistorySnapshot, Self::Error>;
}

pub fn migration_history_rows_select(
    schema: &str,
    columns: MigrationHistoryColumns,
) -> Result<String, QueryContractError> {
    let quoted_schema = quote_identifier(schema)?;
    if !columns.id {
        return Err(QueryContractError::MissingIdColumn);
    }
    let mut selected = vec![quote_identifier("id")?];
    for (present, column) in [
        (columns.name, "name"),
        (columns.hash, "hash"),
        (columns.created_at, "created_at"),
    ] {
        if present {
            selected.push(quote_identifier(column)?);
        }
    }
    Ok(format!(
        "SELECT {} FROM {}.{} ORDER BY {}",
        selected.join(", "),
        quoted_schema,
        quote_identifier(MIGRATION_HISTORY_TABLE_NAME)?,
        quote_identifier("id")?,
    ))
}

pub fn quote_identifier(value: &str) -> Result<String, QueryContractError> {
    if value.is_empty()
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_'
                || byte.is_ascii_alphanumeric() && (index > 0 || byte.is_ascii_alphabetic())
        })
    {
        return Err(QueryContractError::UnsafeIdentifier(value.to_owned()));
    }
    Ok(format!("\"{value}\""))
}
