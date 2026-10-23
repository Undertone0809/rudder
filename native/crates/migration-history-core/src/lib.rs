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
];

// These shipped migrations have explicit history-gap recovery coverage. The
// current SQL hash is part of the allowlist so editing a migration closes the
// exception until its replay safety is reviewed again.
const SAFE_HISTORICAL_GAP_MIGRATIONS: &[(&str, &str)] = &[
    (
        "0044_illegal_toad.sql",
        "d0dda5d7787eff4aefe1ece4e6d25b7947acd08c95e80fa34b170fd1474a04ab",
    ),
    (
        "0063_flawless_toad.sql",
        "5ee91be1af9a41beaa9e1fce8dbe1b05e787c065d236dcc8a6141cb52a859318",
    ),
    (
        "0100_mean_richard_fisk.sql",
        "2adf379d4bdd34ad092f4a2bfa186994724170f56b0ec20f92e32896fd8a85da",
    ),
    (
        "0102_complex_retro_girl.sql",
        "2376722081bca60f0b6f6f6182bdd1102ebf0797a909154029a8c3174e422bc8",
    ),
    (
        "0103_cute_colonel_america.sql",
        "7ad6b24791f1fd2290558c10a5a9bbaf04d3ef209ca35c9dd810ac0e157b9c94",
    ),
];

// These non-idempotent migrations may only have their missing journal row
// repaired after the PostgreSQL adapter proves every catalog effect. This is
// separate from the SQL replay allowlist above.
const CATALOG_HISTORY_REPAIR_MIGRATIONS: &[(&str, &str)] = &[
    (
        "0021_chief_vindicator.sql",
        "1278c77d7de2ad85c4d740092bfd97b1fedb7848bec5a09fc0f72443ffae3daa",
    ),
    (
        "0031_zippy_magma.sql",
        "f1af3a309420879d2a98783650b6389a5b1569b5d21beb053780b26c92de3a13",
    ),
];

fn is_known_legacy_migration_history_hash(hash: &str) -> bool {
    KNOWN_LEGACY_MIGRATION_HISTORY_HASHES.contains(&hash)
}

fn is_safe_historical_gap(entry: &rudder_migration_core::MigrationEntry) -> bool {
    SAFE_HISTORICAL_GAP_MIGRATIONS
        .iter()
        .any(|(file_name, sha256)| entry.file_name == *file_name && entry.sha256 == *sha256)
}

fn is_catalog_history_repair_migration(entry: &rudder_migration_core::MigrationEntry) -> bool {
    CATALOG_HISTORY_REPAIR_MIGRATIONS
        .iter()
        .any(|(file_name, sha256)| entry.file_name == *file_name && entry.sha256 == *sha256)
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
    /// Internal Rust-only candidates; the locked PostgreSQL writer must prove
    /// the complete catalog effect before it may repair any journal row.
    #[doc(hidden)]
    #[serde(skip)]
    pub catalog_repair_candidates: Vec<MigrationHistoryIdentity>,
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
    /// True when at least one current migration was identified by its
    /// manifest name or content hash. Positional ID matches cannot authorize
    /// a known historical gap recovery.
    verified_current_identity: bool,
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

fn row_has_exact_current_identity(
    columns: MigrationHistoryColumns,
    row: &MigrationHistoryRow,
    entry: &rudder_migration_core::MigrationEntry,
) -> bool {
    if columns.hash {
        row.hash.as_deref() == Some(entry.sha256.as_str())
            && row
                .name
                .as_deref()
                .is_none_or(|name| name == entry.file_name)
    } else {
        columns.name && row.name.as_deref() == Some(entry.file_name.as_str())
    }
}

fn validate_snapshot(snapshot: &MigrationHistorySnapshot) -> Result<(), MigrationHistoryError> {
    let mut seen_ids = HashSet::new();
    for (index, row) in snapshot.rows.iter().enumerate() {
        if row.id == 0 {
            return Err(MigrationHistoryError::HistoryRowInvalid(format!(
                "row {index} id must be positive"
            )));
        }
        if !seen_ids.insert(row.id) {
            return Err(MigrationHistoryError::HistoryRowInvalid(format!(
                "row {index} id must be unique"
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
        if snapshot.columns.hash
            && row.hash.as_deref() != Some(manifest.entries[entry_index].sha256.as_str())
        {
            resolution.mismatch = true;
            resolution.diagnostics.push(if row.hash.is_some() {
                format!(
                    "migration history hash does not match {}",
                    manifest.entries[entry_index].file_name
                )
            } else {
                format!(
                    "migration history hash is missing for {}",
                    manifest.entries[entry_index].file_name
                )
            });
        }
        resolution.matches.push(Match {
            row: row.clone(),
            entry_index,
        });
        resolution.verified_current_identity = true;
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
        resolution.verified_current_identity = !resolution.matches.is_empty();
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
    let mut repeated_migration = false;
    for matched in &resolution.matches {
        if !matched_orders.insert(matched.entry_index) {
            mismatch = true;
            repeated_migration = true;
            diagnostics.push("migration history repeats a manifest migration".to_owned());
        }
    }
    // Allowlisted unjournaled SQL is appended to the manifest for identity and
    // hash verification, but is not part of the ordered migration journal.
    // A predecessor may already contain those files before its next journaled
    // migration is applied. Keep duplicate/unknown-row checks for every entry.
    let journal_matches = resolution
        .matches
        .iter()
        .filter(|matched| !manifest.entries[matched.entry_index].is_legacy_unjournaled())
        .collect::<Vec<_>>();
    let expected_journaled_count = manifest
        .entries
        .iter()
        .filter(|entry| !entry.is_legacy_unjournaled())
        .count();
    let complete_current_set = resolution.verified_current_identity
        && journal_matches.len() == expected_journaled_count
        && manifest
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| !entry.is_legacy_unjournaled())
            .all(|(index, _)| matched_orders.contains(&index));
    let mut out_of_order = false;
    // Catalog-repair and approved historical rows are appended when
    // recovered, so their relative journal IDs cannot represent manifest
    // order. Exclude only exact hash/name identities from the order check;
    // unknown, positional, or mismatched rows stay in the strict sequence.
    let ordered_journal_matches = journal_matches
        .iter()
        .filter(|matched| {
            let entry = &manifest.entries[matched.entry_index];
            let exact_current_identity =
                row_has_exact_current_identity(snapshot.columns, &matched.row, entry);
            !exact_current_identity
                || (!is_safe_historical_gap(entry) && !is_catalog_history_repair_migration(entry))
        })
        .collect::<Vec<_>>();
    for pair in ordered_journal_matches.windows(2) {
        if pair[0].entry_index >= pair[1].entry_index {
            mismatch = true;
            out_of_order = true;
            diagnostics.push("migration history order does not match manifest order".to_owned());
            break;
        }
    }
    if !complete_current_set
        && let Some(last_applied_index) = journal_matches
            .iter()
            .map(|matched| matched.entry_index)
            .max()
    {
        let interior_gaps = manifest
            .entries
            .iter()
            .enumerate()
            .filter(|(index, entry)| {
                *index < last_applied_index
                    && !entry.is_legacy_unjournaled()
                    && !matched_orders.contains(index)
            })
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        if !interior_gaps.is_empty()
            && (!resolution.verified_current_identity
                || interior_gaps.iter().any(|entry| {
                    !is_safe_historical_gap(entry) && !is_catalog_history_repair_migration(entry)
                }))
        {
            mismatch = true;
            diagnostics.push(
                "migration history contains a gap outside the approved historical replay set"
                    .to_owned(),
            );
        }
    }
    if resolution.unmatched_rows > 0 {
        mismatch = true;
        diagnostics.push(format!(
            "migration history has {} unmatched row(s)",
            resolution.unmatched_rows
        ));
    }

    // Surface exact catalog-repair candidates only when every existing row
    // has one matching current identity and there are no duplicate, unknown,
    // hash, or ordering conflicts. The service still verifies PostgreSQL's
    // complete catalog shape before any journal or schema mutation.
    let current_rows_have_exact_identity = resolution.matches.iter().all(|matched| {
        let entry = &manifest.entries[matched.entry_index];
        row_has_exact_current_identity(snapshot.columns, &matched.row, entry)
    });
    let structurally_clean = resolution.verified_current_identity
        && current_rows_have_exact_identity
        && !resolution.mismatch
        && !repeated_migration
        && !out_of_order
        && resolution.unmatched_rows == 0;
    let mut catalog_repair_candidates = Vec::new();
    let mut unsupported_interior_gap = false;
    if structurally_clean
        && !complete_current_set
        && let Some(last_applied_index) = journal_matches
            .iter()
            .map(|matched| matched.entry_index)
            .max()
    {
        for (index, entry) in manifest.entries.iter().enumerate() {
            if index >= last_applied_index
                || entry.is_legacy_unjournaled()
                || matched_orders.contains(&index)
                || is_safe_historical_gap(entry)
            {
                continue;
            }
            if is_catalog_history_repair_migration(entry) {
                catalog_repair_candidates.push(pending_identity(manifest, index));
            } else {
                unsupported_interior_gap = true;
            }
        }
    }
    if unsupported_interior_gap {
        catalog_repair_candidates.clear();
        mismatch = true;
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
        catalog_repair_candidates,
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
            catalog_repair_candidates: Vec::new(),
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
            catalog_repair_candidates: Vec::new(),
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
            catalog_repair_candidates: Vec::new(),
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
