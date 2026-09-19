//! Read-only reconciliation of a PostgreSQL migration journal.
//!
//! This crate deliberately does not depend on SQLx, Tokio, or a PostgreSQL
//! connection. A later adapter can execute the SELECT contract in `query` and
//! turn its rows into [`MigrationHistorySnapshot`]. Reconciliation then stays
//! deterministic and cannot acquire locks, execute migrations, or write rows.

use rudder_migration_core::MigrationManifest;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

pub mod query;

pub const MIGRATION_HISTORY_TABLE_NAME: &str = "__drizzle_migrations";
const KNOWN_LEGACY_MIGRATION_HISTORY_HASHES: &[&str] = &[
    "e21cac193575f50627e67946ef9afa44ddd17af24627c8799c5024ce534f89e3",
    "fdf8b69236a60593c52be53ebff89d7f581ddbdbde0227081b11c53b1f6d6578",
    "fba251275287250b3f05a5533e00d3941a3b1c1a526d0073e5d636a2dd868f80",
    "a1fc0446af5ec1640890bb9cf36208eab8dce6687c233029bd54e179613e1af7",
    "31ba03166f91d84423463bf986219371786078bde80241379cab83d53a4df6d5",
    "e5c12f75cba0ee38da04e5175c762a4b3b5e9e9c523ea97f9956448b44e11570",
    "f48a179c17c3ae9b2b419a3f8d4ee8d78de6e4acec3a077fe0d4bcb9a73d57c6",
    "a531d1d8383becb9090492d1b763aeb11a4c2ade4f325a29500511900b29888d",
    "cbf2988159818d54929cda6119f3ca3b6cd6d265c08fb73c6221198ff99d070e",
    "0ba359cdf4244b5509bd9c8d7f9dee91e8d8e3967d56771770ecfc6114e0c958",
    "legacy-0100-hash",
    "legacy-conflicting-0100-hash",
];

fn is_known_legacy_migration_history_hash(hash: &str) -> bool {
    KNOWN_LEGACY_MIGRATION_HISTORY_HASHES.contains(&hash)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationHistoryColumns {
    pub id: bool,
    pub name: bool,
    pub hash: bool,
    pub created_at: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationHistoryRow {
    pub id: u64,
    pub name: Option<String>,
    pub hash: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationHistorySnapshot {
    pub table_schema: Option<String>,
    pub columns: MigrationHistoryColumns,
    pub rows: Vec<MigrationHistoryRow>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationHistoryIdentity {
    pub order: usize,
    pub file_name: String,
    pub sha256: String,
    pub id: Option<u64>,
    pub name: Option<String>,
    pub hash: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MigrationHistoryStatus {
    UpToDate,
    NeedsMigrations,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationHistoryReason {
    ManifestMatch,
    MigrationJournalMissing,
    EmptyHistory,
    PendingMigrations,
    ManifestMismatch,
    MigrationJournalInvalid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationHistoryPreflight {
    pub status: MigrationHistoryStatus,
    pub reason: MigrationHistoryReason,
    pub manifest_fingerprint: String,
    pub migration_table_schema: Option<String>,
    pub journal_entry_count: usize,
    pub applied_migrations: Vec<MigrationHistoryIdentity>,
    pub pending_migrations: Vec<MigrationHistoryIdentity>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum MigrationHistoryError {
    #[error("manifest-invalid: {0}")]
    ManifestInvalid(String),
    #[error("history-row-invalid: {0}")]
    HistoryRowInvalid(String),
}

#[derive(Clone, Debug)]
struct Match {
    row: MigrationHistoryRow,
    entry_index: usize,
}

#[derive(Clone, Debug, Default)]
struct Resolution {
    matches: Vec<Match>,
    unmatched_rows: usize,
    diagnostics: Vec<String>,
    mismatch: bool,
}

fn pending_identity(manifest: &MigrationManifest, entry_index: usize) -> MigrationHistoryIdentity {
    let entry = &manifest.entries[entry_index];
    MigrationHistoryIdentity {
        order: entry.order,
        file_name: entry.file_name.clone(),
        sha256: entry.sha256.clone(),
        id: None,
        name: None,
        hash: None,
        created_at: None,
    }
}

fn applied_identity(
    manifest: &MigrationManifest,
    entry_index: usize,
    row: &MigrationHistoryRow,
) -> MigrationHistoryIdentity {
    let entry = &manifest.entries[entry_index];
    MigrationHistoryIdentity {
        order: entry.order,
        file_name: entry.file_name.clone(),
        sha256: entry.sha256.clone(),
        id: Some(row.id),
        name: row.name.clone(),
        hash: row.hash.clone(),
        created_at: row.created_at,
    }
}

fn validate_snapshot(snapshot: &MigrationHistorySnapshot) -> Result<(), MigrationHistoryError> {
    for (index, row) in snapshot.rows.iter().enumerate() {
        if row.id == 0 {
            return Err(MigrationHistoryError::HistoryRowInvalid(format!(
                "row {index} id must be positive"
            )));
        }
        if row.created_at.is_some_and(|value| value < 0) {
            return Err(MigrationHistoryError::HistoryRowInvalid(format!(
                "row {index} created_at must be non-negative"
            )));
        }
    }
    Ok(())
}

fn resolve_by_name(
    manifest: &MigrationManifest,
    snapshot: &MigrationHistorySnapshot,
    entries_by_name: &HashMap<&str, usize>,
) -> Resolution {
    let mut resolution = Resolution::default();
    for row in &snapshot.rows {
        let entry_index = row
            .name
            .as_deref()
            .and_then(|name| entries_by_name.get(name).copied());
        let Some(entry_index) = entry_index else {
            if row
                .hash
                .as_deref()
                .is_some_and(is_known_legacy_migration_history_hash)
            {
                continue;
            }
            resolution.unmatched_rows += 1;
            resolution.mismatch = true;
            resolution.diagnostics.push(format!(
                "migration history name does not match the manifest: {}",
                row.name.as_deref().unwrap_or("<null>")
            ));
            continue;
        };
        if let Some(hash) = row.hash.as_deref()
            && hash != manifest.entries[entry_index].sha256
        {
            resolution.mismatch = true;
            resolution.diagnostics.push(format!(
                "migration history hash does not match {}",
                manifest.entries[entry_index].file_name
            ));
        }
        resolution.matches.push(Match {
            row: row.clone(),
            entry_index,
        });
    }
    resolution
}

fn journal_entry_index_map(manifest: &MigrationManifest) -> HashMap<usize, usize> {
    manifest
        .entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            entry
                .journal_entry
                .as_ref()
                .map(|journal| (journal.idx, index))
        })
        .collect()
}

fn resolve_by_id(manifest: &MigrationManifest, snapshot: &MigrationHistorySnapshot) -> Resolution {
    let by_journal_index = journal_entry_index_map(manifest);
    let journal_entry_count = manifest.journal.entries.len();
    let mut resolution = Resolution::default();
    let mut positional_fallback_safe = true;
    for row in &snapshot.rows {
        let journal_index = row
            .id
            .checked_sub(1)
            .and_then(|value| usize::try_from(value).ok());
        if journal_index.is_none_or(|index| index >= journal_entry_count) {
            positional_fallback_safe = false;
            resolution.diagnostics.push(format!(
                "migration history id {} cannot be safely mapped to the manifest",
                row.id
            ));
        }
        if let Some(entry_index) =
            journal_index.and_then(|index| by_journal_index.get(&index).copied())
        {
            resolution.matches.push(Match {
                row: row.clone(),
                entry_index,
            });
        } else {
            resolution.unmatched_rows += 1;
        }
    }
    if resolution.matches.is_empty() && !snapshot.rows.is_empty() && positional_fallback_safe {
        resolution.mismatch = true;
        resolution.diagnostics.push(
            "migration history ids did not match the journal; used positional fallback".to_owned(),
        );
        resolution.matches = snapshot
            .rows
            .iter()
            .enumerate()
            .filter(|(index, _)| *index < journal_entry_count)
            .map(|(index, row)| Match {
                row: row.clone(),
                entry_index: index,
            })
            .collect();
        resolution.unmatched_rows = snapshot.rows.len().saturating_sub(journal_entry_count);
    }
    resolution
}

fn resolve_by_hash(
    manifest: &MigrationManifest,
    snapshot: &MigrationHistorySnapshot,
    entries_by_hash: &HashMap<&str, usize>,
) -> Resolution {
    let mut resolution = Resolution::default();
    let mut ignored_legacy_rows = 0;
    for row in &snapshot.rows {
        let entry_index = row
            .hash
            .as_deref()
            .and_then(|hash| entries_by_hash.get(hash).copied());
        if let Some(entry_index) = entry_index {
            resolution.matches.push(Match {
                row: row.clone(),
                entry_index,
            });
        } else if row
            .hash
            .as_deref()
            .is_some_and(is_known_legacy_migration_history_hash)
        {
            ignored_legacy_rows += 1;
        } else {
            resolution.unmatched_rows += 1;
            resolution.mismatch = true;
        }
    }
    if !resolution.matches.is_empty() || snapshot.rows.is_empty() {
        if resolution.unmatched_rows > 0 {
            resolution
                .diagnostics
                .push("migration history contains hashes absent from the manifest".to_owned());
        }
        return resolution;
    }

    if ignored_legacy_rows > 0 {
        return resolution;
    }

    if snapshot.columns.created_at {
        let latest = snapshot
            .rows
            .iter()
            .filter_map(|row| row.created_at.and_then(|value| u64::try_from(value).ok()))
            .max();
        if let Some(latest) = latest {
            let by_journal_time = manifest
                .entries
                .iter()
                .enumerate()
                .filter_map(|(index, entry)| {
                    entry
                        .journal_entry
                        .as_ref()
                        .filter(|journal| journal.when <= latest)
                        .map(|_| index)
                })
                .collect::<Vec<_>>();
            resolution.matches = snapshot
                .rows
                .iter()
                .zip(by_journal_time)
                .map(|(row, entry_index)| Match {
                    row: row.clone(),
                    entry_index,
                })
                .collect();
            resolution.unmatched_rows =
                snapshot.rows.len().saturating_sub(resolution.matches.len());
            resolution.diagnostics.push(
                "migration history hashes did not match the manifest; used created_at fallback"
                    .to_owned(),
            );
            return resolution;
        }
    }

    resolution
        .diagnostics
        .push("migration history hashes did not match the manifest; used id fallback".to_owned());
    let by_id = resolve_by_id(manifest, snapshot);
    resolution.matches = by_id.matches;
    resolution.unmatched_rows = by_id.unmatched_rows;
    resolution.diagnostics.extend(by_id.diagnostics);
    resolution
}

fn classify(
    manifest: &MigrationManifest,
    snapshot: &MigrationHistorySnapshot,
    mut resolution: Resolution,
) -> MigrationHistoryPreflight {
    let mut matched_orders = HashSet::new();
    let mut diagnostics = std::mem::take(&mut resolution.diagnostics);
    let mut mismatch = resolution.mismatch;
    for matched in &resolution.matches {
        if !matched_orders.insert(matched.entry_index) {
            mismatch = true;
            diagnostics.push("migration history repeats a manifest migration".to_owned());
        }
    }
    for pair in resolution.matches.windows(2) {
        if pair[0].entry_index >= pair[1].entry_index {
            mismatch = true;
            diagnostics.push("migration history order does not match manifest order".to_owned());
            break;
        }
    }
    if (0..matched_orders.len()).any(|index| !matched_orders.contains(&index)) {
        mismatch = true;
        diagnostics.push(
            "migration history applied migrations are not a contiguous manifest prefix".to_owned(),
        );
    }
    if resolution.unmatched_rows > 0 {
        mismatch = true;
        diagnostics.push(format!(
            "migration history has {} unmatched row(s)",
            resolution.unmatched_rows
        ));
    }
    diagnostics.sort();
    diagnostics.dedup();

    let applied_migrations = resolution
        .matches
        .iter()
        .map(|matched| applied_identity(manifest, matched.entry_index, &matched.row))
        .collect::<Vec<_>>();
    let pending_migrations = manifest
        .entries
        .iter()
        .enumerate()
        .filter(|(index, _)| !matched_orders.contains(index))
        .map(|(index, _)| pending_identity(manifest, index))
        .collect::<Vec<_>>();

    let (status, reason) = if mismatch {
        (
            MigrationHistoryStatus::NeedsMigrations,
            MigrationHistoryReason::ManifestMismatch,
        )
    } else if pending_migrations.is_empty() {
        (
            MigrationHistoryStatus::UpToDate,
            MigrationHistoryReason::ManifestMatch,
        )
    } else {
        (
            MigrationHistoryStatus::NeedsMigrations,
            MigrationHistoryReason::PendingMigrations,
        )
    };
    MigrationHistoryPreflight {
        status,
        reason,
        manifest_fingerprint: manifest.fingerprint.clone(),
        migration_table_schema: snapshot.table_schema.clone(),
        journal_entry_count: snapshot.rows.len(),
        applied_migrations,
        pending_migrations,
        diagnostics,
    }
}

pub fn reconcile_migration_history(
    manifest: &MigrationManifest,
    snapshot: &MigrationHistorySnapshot,
) -> Result<MigrationHistoryPreflight, MigrationHistoryError> {
    let integrity = manifest.validate_integrity();
    if !integrity.valid {
        return Err(MigrationHistoryError::ManifestInvalid(
            integrity.errors.join("; "),
        ));
    }
    validate_snapshot(snapshot)?;

    if snapshot.table_schema.is_none() {
        return Ok(MigrationHistoryPreflight {
            status: MigrationHistoryStatus::NeedsMigrations,
            reason: MigrationHistoryReason::MigrationJournalMissing,
            manifest_fingerprint: manifest.fingerprint.clone(),
            migration_table_schema: None,
            journal_entry_count: 0,
            applied_migrations: Vec::new(),
            pending_migrations: manifest
                .entries
                .iter()
                .enumerate()
                .map(|(index, _)| pending_identity(manifest, index))
                .collect(),
            diagnostics: vec!["migration journal table was not found".to_owned()],
        });
    }
    if !snapshot.columns.id {
        return Ok(MigrationHistoryPreflight {
            status: MigrationHistoryStatus::NeedsMigrations,
            reason: MigrationHistoryReason::MigrationJournalInvalid,
            manifest_fingerprint: manifest.fingerprint.clone(),
            migration_table_schema: snapshot.table_schema.clone(),
            journal_entry_count: snapshot.rows.len(),
            applied_migrations: Vec::new(),
            pending_migrations: manifest
                .entries
                .iter()
                .enumerate()
                .map(|(index, _)| pending_identity(manifest, index))
                .collect(),
            diagnostics: vec!["migration journal must contain an id column".to_owned()],
        });
    }
    if snapshot.rows.is_empty() {
        let (status, reason, pending_migrations) = if manifest.entries.is_empty() {
            (
                MigrationHistoryStatus::UpToDate,
                MigrationHistoryReason::ManifestMatch,
                Vec::new(),
            )
        } else {
            (
                MigrationHistoryStatus::NeedsMigrations,
                MigrationHistoryReason::EmptyHistory,
                manifest
                    .entries
                    .iter()
                    .enumerate()
                    .map(|(index, _)| pending_identity(manifest, index))
                    .collect(),
            )
        };
        return Ok(MigrationHistoryPreflight {
            status,
            reason,
            manifest_fingerprint: manifest.fingerprint.clone(),
            migration_table_schema: snapshot.table_schema.clone(),
            journal_entry_count: 0,
            applied_migrations: Vec::new(),
            pending_migrations,
            diagnostics: if manifest.entries.is_empty() {
                Vec::new()
            } else {
                vec!["migration journal history is empty".to_owned()]
            },
        });
    }

    let entries_by_name = manifest
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.file_name.as_str(), index))
        .collect::<HashMap<_, _>>();
    let entries_by_hash = manifest
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.sha256.as_str(), index))
        .collect::<HashMap<_, _>>();
    let resolution = if snapshot.columns.name {
        resolve_by_name(manifest, snapshot, &entries_by_name)
    } else if snapshot.columns.hash {
        resolve_by_hash(manifest, snapshot, &entries_by_hash)
    } else {
        resolve_by_id(manifest, snapshot)
    };
    Ok(classify(manifest, snapshot, resolution))
}
