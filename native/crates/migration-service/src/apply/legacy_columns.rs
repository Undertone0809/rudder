//! Fixed compatibility renames previously performed by the Node migration
//! startup path. Keep this list intentionally narrow; it is not a generic
//! schema reconciliation mechanism.

use sqlx::{Connection, PgConnection, Row};
use std::collections::HashSet;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Rename {
    table: &'static str,
    from: &'static str,
    to: &'static str,
}

const RENAMES: [Rename; 7] = [
    Rename {
        table: "agents",
        from: "adapter_type",
        to: "agent_runtime_type",
    },
    Rename {
        table: "agents",
        from: "adapter_config",
        to: "agent_runtime_config",
    },
    Rename {
        table: "agent_runtime_state",
        from: "adapter_type",
        to: "agent_runtime_type",
    },
    Rename {
        table: "agent_task_sessions",
        from: "adapter_type",
        to: "agent_runtime_type",
    },
    Rename {
        table: "join_requests",
        from: "adapter_type",
        to: "agent_runtime_type",
    },
    Rename {
        table: "finance_events",
        from: "execution_adapter_type",
        to: "execution_agent_runtime_type",
    },
    Rename {
        table: "issues",
        from: "assignee_adapter_overrides",
        to: "assignee_agent_runtime_overrides",
    },
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Snapshot {
    pub pending: Vec<Rename>,
    pub collisions: Vec<Rename>,
}

impl Snapshot {
    pub(super) fn collision_labels(&self) -> Vec<String> {
        self.collisions
            .iter()
            .map(|rename| format!("{}.{}+{}", rename.table, rename.from, rename.to))
            .collect()
    }

    pub(super) fn pending_labels(&self) -> Vec<String> {
        self.pending.iter().map(label).collect()
    }
}

#[derive(Debug)]
pub(super) enum ApplyError {
    Database(sqlx::Error),
    StateChanged,
    Collision(Vec<String>),
    Cancelled,
}

/// Reads only the seven supported table/column pairs in the public schema.
/// If both names exist, report a collision rather than risking data loss.
pub(super) async fn inspect(connection: &mut PgConnection) -> Result<Snapshot, sqlx::Error> {
    let tables = [
        "agents",
        "agent_runtime_state",
        "agent_task_sessions",
        "join_requests",
        "finance_events",
        "issues",
    ];
    let columns = [
        "adapter_type",
        "adapter_config",
        "agent_runtime_type",
        "agent_runtime_config",
        "execution_adapter_type",
        "execution_agent_runtime_type",
        "assignee_adapter_overrides",
        "assignee_agent_runtime_overrides",
    ];
    let rows = sqlx::query(
        "SELECT table_name, column_name \
         FROM information_schema.columns \
         WHERE table_schema = 'public' \
           AND table_name = ANY($1) \
           AND column_name = ANY($2)",
    )
    .bind(tables.as_slice())
    .bind(columns.as_slice())
    .fetch_all(&mut *connection)
    .await?;
    let present = rows
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("table_name")?,
                row.try_get::<String, _>("column_name")?,
            ))
        })
        .collect::<Result<HashSet<_>, sqlx::Error>>()?;

    let mut snapshot = Snapshot {
        pending: Vec::new(),
        collisions: Vec::new(),
    };
    for rename in RENAMES {
        let from_exists = present.contains(&(rename.table.to_owned(), rename.from.to_owned()));
        let to_exists = present.contains(&(rename.table.to_owned(), rename.to.to_owned()));
        match (from_exists, to_exists) {
            (true, false) => snapshot.pending.push(rename),
            (true, true) => snapshot.collisions.push(rename),
            _ => {}
        }
    }
    Ok(snapshot)
}

/// Rechecks the exact alias snapshot inside one PostgreSQL transaction, then
/// applies every pending rename atomically.
pub(super) async fn apply(
    connection: &mut PgConnection,
    expected: &Snapshot,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, ApplyError> {
    if cancellation.is_cancelled() {
        return Err(ApplyError::Cancelled);
    }
    let mut transaction = connection.begin().await.map_err(ApplyError::Database)?;
    match apply_in_transaction(&mut transaction, expected, cancellation).await {
        Ok(labels) => {
            transaction.commit().await.map_err(ApplyError::Database)?;
            Ok(labels)
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
    }
}

/// Applies the exact alias snapshot to a caller-owned transaction so catalog
/// proof and history repair can roll back the rename together on rejection.
pub(super) async fn apply_in_transaction(
    connection: &mut PgConnection,
    expected: &Snapshot,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, ApplyError> {
    if cancellation.is_cancelled() {
        return Err(ApplyError::Cancelled);
    }
    let actual = inspect(connection).await.map_err(ApplyError::Database)?;
    if cancellation.is_cancelled() {
        return Err(ApplyError::Cancelled);
    }
    if !actual.collisions.is_empty() {
        return Err(ApplyError::Collision(actual.collision_labels()));
    }
    if &actual != expected {
        return Err(ApplyError::StateChanged);
    }

    for rename in &expected.pending {
        if cancellation.is_cancelled() {
            return Err(ApplyError::Cancelled);
        }
        let sql = format!(
            "ALTER TABLE \"public\".\"{}\" RENAME COLUMN \"{}\" TO \"{}\"",
            rename.table, rename.from, rename.to
        );
        sqlx::query(&sql)
            .execute(&mut *connection)
            .await
            .map_err(ApplyError::Database)?;
    }

    if cancellation.is_cancelled() {
        return Err(ApplyError::Cancelled);
    }
    Ok(expected.pending_labels())
}

fn label(rename: &Rename) -> String {
    format!("{}.{}->{}", rename.table, rename.from, rename.to)
}
