use rudder_migration_core::{MigrationLimits, MigrationManifest, load_migration_manifest};
use rudder_migration_history_core::{
    MigrationHistoryColumns, MigrationHistoryPreflight, MigrationHistoryReason,
    MigrationHistoryRow, MigrationHistorySnapshot, MigrationHistoryStatus,
    reconcile_migration_history,
};
use std::fs::{create_dir_all, write};
use tempfile::TempDir;

fn manifest(names: &[&str]) -> (TempDir, MigrationManifest) {
    manifest_with_legacy_tail(names, &[])
}

fn manifest_with_legacy_tail(
    journal_names: &[&str],
    legacy_names: &[&str],
) -> (TempDir, MigrationManifest) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    create_dir_all(&meta).unwrap();
    for name in journal_names.iter().chain(legacy_names.iter()) {
        write(migrations.join(name), name.as_bytes()).unwrap();
    }
    let journal_entries = journal_names
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

const KNOWN_LEGACY_MIGRATION_HISTORY_HASHES: [&str; 12] = [
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
fn known_legacy_hashes_are_ignored_but_unknown_hashes_fail_closed() {
    let (_root, manifest) = manifest(&["0000_first.sql"]);
    let mut known_rows = vec![MigrationHistoryRow {
        id: 1,
        name: None,
        hash: Some(hash_for("0000_first.sql")),
        created_at: None,
    }];
    known_rows.extend(
        KNOWN_LEGACY_MIGRATION_HISTORY_HASHES
            .iter()
            .enumerate()
            .map(|(index, hash)| MigrationHistoryRow {
                id: (index + 2) as u64,
                name: None,
                hash: Some((*hash).to_owned()),
                created_at: None,
            }),
    );
    let known = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                hash: true,
                ..Default::default()
            },
            known_rows,
        ),
    )
    .unwrap();

    assert_eq!(known.status, MigrationHistoryStatus::UpToDate);
    assert_eq!(known.reason, MigrationHistoryReason::ManifestMatch);
    assert_eq!(known.applied_migrations.len(), 1);
    assert!(known.pending_migrations.is_empty());

    let unknown = reconcile_migration_history(
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
                    id: 2,
                    name: None,
                    hash: Some("unknown-legacy-hash".to_owned()),
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_eq!(unknown.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(unknown.reason, MigrationHistoryReason::ManifestMismatch);
    assert_eq!(unknown.applied_migrations.len(), 1);
    assert!(unknown.pending_migrations.is_empty());
    assert!(
        unknown
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("unmatched row"))
    );
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
fn id_fallback_does_not_map_an_unjournaled_legacy_tail() {
    let (_root, manifest) = manifest_with_legacy_tail(
        &["0000_first.sql", "0001_second.sql"],
        &["0055_illegal_sheva_callister.sql"],
    );
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                ..Default::default()
            },
            vec![MigrationHistoryRow {
                id: 3,
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
    assert_eq!(
        result
            .pending_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        [
            "0000_first.sql",
            "0001_second.sql",
            "0055_illegal_sheva_callister.sql"
        ]
    );
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
