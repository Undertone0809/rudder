//! Read only the native schema needed by the calibrated OpenCode writer.
//! A newer operator database must never be downgraded or silently relocated.

use super::{Result, unsupported};
use rusqlite::{Connection, OpenFlags};
use std::{collections::BTreeSet, path::Path, time::Duration};

const INCOMPATIBLE: &str =
    "the OpenCode profile database is incompatible with the calibrated native CLI";
const UNAVAILABLE: &str = "the OpenCode profile database cannot be checked read-only";

pub(super) fn validate_profile_database(home: &Path) -> Result<()> {
    // Custom XDG roots are rejected separately by the host/profile resolver.
    let database = home.join(".local/share/opencode/opencode.db");
    match std::fs::metadata(&database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(metadata) if metadata.is_file() => {}
        _ => return Err(unsupported(UNAVAILABLE)),
    }
    let connection = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| unsupported(UNAVAILABLE))?;
    connection
        .busy_timeout(Duration::from_millis(100))
        .and_then(|()| connection.execute_batch("PRAGMA query_only = ON"))
        .map_err(|_| unsupported(UNAVAILABLE))?;
    validate_schema(&connection)
}

fn validate_schema(connection: &Connection) -> Result<()> {
    // These are the complete INSERT column sets used by OpenCode 1.15.11.
    // Optional additive columns remain compatible; an extra required column
    // without a default (for example session_message.seq) breaks that writer.
    for (table, written) in [
        (
            "session_message",
            &[
                "id",
                "session_id",
                "type",
                "time_created",
                "time_updated",
                "data",
            ][..],
        ),
        (
            "permission",
            &["project_id", "time_created", "time_updated", "data"][..],
        ),
    ] {
        let mut statement = connection
            .prepare("SELECT name, \"notnull\", dflt_value FROM pragma_table_info(?1)")
            .map_err(|_| unsupported(UNAVAILABLE))?;
        let columns = statement
            .query_map([table], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|_| unsupported(UNAVAILABLE))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| unsupported(UNAVAILABLE))?;
        let names: BTreeSet<_> = columns.iter().map(|(name, _, _)| name.as_str()).collect();
        if written.iter().any(|name| !names.contains(name))
            || columns.iter().any(|(name, required, default)| {
                *required
                    && default.as_ref().is_none_or(|value| {
                        value
                            .trim()
                            .trim_matches(['(', ')'])
                            .trim()
                            .eq_ignore_ascii_case("NULL")
                    })
                    && !written.contains(&name.as_str())
            })
        {
            return Err(unsupported(INCOMPATIBLE));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = "
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
          time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE TABLE permission (
          project_id TEXT PRIMARY KEY, time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL, data TEXT NOT NULL
        );";

    #[test]
    fn missing_database_is_not_created_by_readiness() {
        let home = tempfile::tempdir().unwrap();
        validate_profile_database(home.path()).unwrap();
        assert!(!home.path().join(".local").exists());
    }

    #[test]
    fn native_schema_and_safe_optional_additions_are_accepted_read_only() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".local/share/opencode");
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("opencode.db");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        connection
            .execute_batch("ALTER TABLE session_message ADD COLUMN optional_note TEXT")
            .unwrap();
        drop(connection);
        let before = std::fs::read(&database).unwrap();
        validate_profile_database(home.path()).unwrap();
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn newer_required_column_is_rejected_without_changing_native_database() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".local/share/opencode");
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("opencode.db");
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        connection
            .execute_batch("ALTER TABLE session_message ADD COLUMN seq INTEGER NOT NULL")
            .unwrap();
        drop(connection);
        let before = std::fs::read(&database).unwrap();
        assert!(validate_profile_database(home.path()).is_err());
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn missing_native_writer_column_is_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        connection
            .execute_batch("ALTER TABLE permission DROP COLUMN data")
            .unwrap();
        assert!(validate_schema(&connection).is_err());
    }

    #[test]
    fn null_default_does_not_make_an_extra_required_column_writable() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE session_message ADD COLUMN seq INTEGER NOT NULL DEFAULT NULL",
            )
            .unwrap();
        assert!(validate_schema(&connection).is_err());
    }

    #[test]
    fn malformed_native_database_is_preserved_and_rejected() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".local/share/opencode");
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("opencode.db");
        std::fs::write(&database, b"synthetic non-SQLite content").unwrap();
        let before = std::fs::read(&database).unwrap();
        assert!(validate_profile_database(home.path()).is_err());
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }
}
