use rudder_migration_core::{MigrationLimits, MigrationManifest, load_migration_manifest};
use rudder_migration_history_core::{
    MigrationHistoryColumns, MigrationHistoryPreflight, MigrationHistoryReason,
    MigrationHistoryRow, MigrationHistorySnapshot, MigrationHistoryStatus,
    reconcile_migration_history,
};
use std::fs::{create_dir_all, write};
use tempfile::TempDir;

fn manifest(names: &[&str]) -> (TempDir, MigrationManifest) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    create_dir_all(&meta).unwrap();
    for name in names {
        write(migrations.join(name), name.as_bytes()).unwrap();
    }
    let journal_entries = names
        .iter()
        .enumerate()
        .map(|(idx, name)| {
            format!(
                r#"{{"idx":{idx},"version":"7","when":{},"tag":"{}","breakpoints":true}}"#,
                1_000 + idx,
                name.trim_end_matches(".sql")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let journal =
        format!(r#"{{"version":"7","dialect":"postgresql","entries":[{journal_entries}]}}"#);
    let journal_path = meta.join("_journal.json");
    write(&journal_path, journal).unwrap();
    let result =
        load_migration_manifest(&journal_path, &migrations, MigrationLimits::default()).unwrap();
    (root, result)
}

fn snapshot(
    columns: MigrationHistoryColumns,
    rows: Vec<MigrationHistoryRow>,
) -> MigrationHistorySnapshot {
    MigrationHistorySnapshot {
        table_schema: Some("drizzle".to_owned()),
        columns,
        rows,
    }
}

fn hash_for(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[test]
fn empty_history_reports_all_pending() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                hash: true,
                created_at: true,
                ..Default::default()
            },
            vec![],
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::EmptyHistory);
    assert_eq!(result.applied_migrations, []);
    assert_eq!(
        result
            .pending_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0000_first.sql", "0001_second.sql"]
    );
}

#[test]
fn exact_hash_history_is_up_to_date_and_keeps_identity() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                hash: true,
                created_at: true,
                ..Default::default()
            },
            vec![
                MigrationHistoryRow {
                    id: 1,
                    name: None,
                    hash: Some(hash_for("0000_first.sql")),
                    created_at: Some(1_000),
                },
                MigrationHistoryRow {
                    id: 2,
                    name: None,
                    hash: Some(hash_for("0001_second.sql")),
                    created_at: Some(1_001),
                },
            ],
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::UpToDate);
    assert_eq!(result.reason, MigrationHistoryReason::ManifestMatch);
    assert_eq!(result.manifest_fingerprint, manifest.fingerprint);
    assert_eq!(result.applied_migrations[1].file_name, "0001_second.sql");
    assert_eq!(result.applied_migrations[1].id, Some(2));
    assert!(result.pending_migrations.is_empty());
}

#[test]
fn name_history_preserves_node_name_precedence() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql", "0002_third.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                name: true,
                hash: true,
                created_at: true,
            },
            vec![
                MigrationHistoryRow {
                    id: 1,
                    name: Some("0000_first.sql".to_owned()),
                    hash: None,
                    created_at: None,
                },
                MigrationHistoryRow {
                    id: 2,
                    name: Some("0001_second.sql".to_owned()),
                    hash: None,
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_eq!(result.reason, MigrationHistoryReason::PendingMigrations);
    assert_eq!(result.applied_migrations.len(), 2);
    assert_eq!(result.pending_migrations[0].file_name, "0002_third.sql");
}

fn assert_manifest_gap(result: &MigrationHistoryPreflight) {
    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
    assert_eq!(
        result
            .applied_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0000_first.sql", "0002_third.sql"]
    );
    assert_eq!(
        result
            .pending_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0001_second.sql"]
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("contiguous manifest prefix"))
    );
}

#[test]
fn name_history_gap_is_manifest_mismatch() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql", "0002_third.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                name: true,
                ..Default::default()
            },
            vec![
                MigrationHistoryRow {
                    id: 1,
                    name: Some("0000_first.sql".to_owned()),
                    hash: None,
                    created_at: None,
                },
                MigrationHistoryRow {
                    id: 3,
                    name: Some("0002_third.sql".to_owned()),
                    hash: None,
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_manifest_gap(&result);
}

#[test]
fn hash_history_gap_is_manifest_mismatch() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql", "0002_third.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                hash: true,
                ..Default::default()
            },
            vec![
                MigrationHistoryRow {
                    id: 1,
                    name: None,
                    hash: Some(hash_for("0000_first.sql")),
                    created_at: None,
                },
                MigrationHistoryRow {
                    id: 3,
                    name: None,
                    hash: Some(hash_for("0002_third.sql")),
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_manifest_gap(&result);
}

#[test]
fn id_history_gap_is_manifest_mismatch() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql", "0002_third.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                ..Default::default()
            },
            vec![
                MigrationHistoryRow {
                    id: 1,
                    name: None,
                    hash: None,
                    created_at: None,
                },
                MigrationHistoryRow {
                    id: 3,
                    name: None,
                    hash: None,
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_manifest_gap(&result);
}

#[test]
fn out_of_range_id_is_unmatched_without_positional_fallback() {
    let (_root, manifest) = manifest(&["0000_first.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                ..Default::default()
            },
            vec![MigrationHistoryRow {
                id: u64::MAX,
                name: None,
                hash: None,
                created_at: None,
            }],
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
    assert!(result.applied_migrations.is_empty());
    assert_eq!(result.pending_migrations.len(), 1);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("cannot be safely mapped"))
    );
}

#[test]
fn created_at_fallback_maps_legacy_hash_rows_but_marks_manifest_mismatch() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                hash: true,
                created_at: true,
                ..Default::default()
            },
            vec![MigrationHistoryRow {
                id: 9,
                name: None,
                hash: Some("archived-hash".to_owned()),
                created_at: Some(1_001),
            }],
        ),
    )
    .unwrap();

    assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
    assert_eq!(result.applied_migrations[0].file_name, "0000_first.sql");
    assert_eq!(result.pending_migrations[0].file_name, "0001_second.sql");
}

#[test]
fn id_only_history_maps_journal_order_and_append_is_pending() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql", "0002_third.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                ..Default::default()
            },
            vec![
                MigrationHistoryRow {
                    id: 1,
                    name: None,
                    hash: None,
                    created_at: None,
                },
                MigrationHistoryRow {
                    id: 2,
                    name: None,
                    hash: None,
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::PendingMigrations);
    assert_eq!(result.pending_migrations[0].file_name, "0002_third.sql");
}

#[test]
fn missing_journal_and_invalid_rows_fail_closed() {
    let (_root, manifest) = manifest(&["0000_first.sql"]);
    let missing = reconcile_migration_history(
        &manifest,
        &MigrationHistorySnapshot {
            table_schema: None,
            columns: MigrationHistoryColumns::default(),
            rows: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        missing.reason,
        MigrationHistoryReason::MigrationJournalMissing
    );

    let invalid = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                ..Default::default()
            },
            vec![MigrationHistoryRow {
                id: 0,
                name: None,
                hash: None,
                created_at: None,
            }],
        ),
    )
    .unwrap_err();
    assert!(invalid.to_string().contains("history-row-invalid"));
}
