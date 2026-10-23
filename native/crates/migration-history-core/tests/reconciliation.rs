use rudder_migration_core::{MigrationLimits, MigrationManifest, load_migration_manifest};
use rudder_migration_history_core::{
    MigrationHistoryColumns, MigrationHistoryPreflight, MigrationHistoryReason,
    MigrationHistoryRow, MigrationHistorySnapshot, MigrationHistoryStatus,
    reconcile_migration_history,
};
use std::fs::{create_dir_all, write};
use std::path::PathBuf;
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
    hash_content(name)
}

fn hash_content(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn manifest_with_shipped_gap(file_name: &str, sql: &str) -> (TempDir, MigrationManifest) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    create_dir_all(&meta).unwrap();
    let entries = [
        ("0030_before.sql", "SELECT 1;"),
        (file_name, sql),
        ("9999_after.sql", "SELECT 2;"),
    ];
    for (name, content) in entries {
        write(migrations.join(name), content).unwrap();
    }
    let journal_entries = entries
        .iter()
        .enumerate()
        .map(|(idx, (name, _))| {
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
    let manifest =
        load_migration_manifest(&journal_path, &migrations, MigrationLimits::default()).unwrap();
    (root, manifest)
}

fn manifest_with_exact_catalog_repair_entries(include_tail: bool) -> (TempDir, MigrationManifest) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    create_dir_all(&meta).unwrap();
    let mut entries = vec![
        ("0000_before.sql", "SELECT 0;"),
        (
            "0021_chief_vindicator.sql",
            include_str!("../../../../packages/db/src/migrations/0021_chief_vindicator.sql"),
        ),
        ("0030_between.sql", "SELECT 30;"),
        (
            "0031_zippy_magma.sql",
            include_str!("../../../../packages/db/src/migrations/0031_zippy_magma.sql"),
        ),
        ("0040_after.sql", "SELECT 40;"),
    ];
    if include_tail {
        entries.push(("0050_new_tail.sql", "SELECT 50;"));
    }
    for (name, sql) in &entries {
        write(migrations.join(name), sql).unwrap();
    }
    let journal_entries = entries
        .iter()
        .enumerate()
        .map(|(idx, (name, _))| {
            format!(
                r#"{{"idx":{idx},"version":"7","when":{},"tag":"{}","breakpoints":true}}"#,
                1_000 + idx,
                name.trim_end_matches(".sql")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    write(
        meta.join("_journal.json"),
        format!(r#"{{"version":"7","dialect":"postgresql","entries":[{journal_entries}]}}"#),
    )
    .unwrap();
    let manifest = load_migration_manifest(
        &meta.join("_journal.json"),
        &migrations,
        MigrationLimits::default(),
    )
    .unwrap();
    (root, manifest)
}

fn history_rows_in_manifest_order(
    manifest: &MigrationManifest,
    ordered_indices: &[usize],
) -> Vec<MigrationHistoryRow> {
    ordered_indices
        .iter()
        .enumerate()
        .map(|(position, entry_index)| MigrationHistoryRow {
            id: position as u64 + 1,
            name: None,
            hash: Some(manifest.entries[*entry_index].sha256.clone()),
            created_at: Some(position as i64 + 1_000),
        })
        .collect()
}

fn name_only_history_rows_in_manifest_order(
    manifest: &MigrationManifest,
    ordered_indices: &[usize],
) -> Vec<MigrationHistoryRow> {
    ordered_indices
        .iter()
        .enumerate()
        .map(|(position, entry_index)| MigrationHistoryRow {
            id: position as u64 + 1,
            name: Some(manifest.entries[*entry_index].file_name.clone()),
            hash: None,
            created_at: Some(position as i64 + 1_000),
        })
        .collect()
}

const KNOWN_LEGACY_MIGRATION_HISTORY_HASHES: [&str; 10] = [
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
                hash: false,
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

#[test]
fn name_identity_with_a_conflicting_hash_still_fails_closed() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                name: true,
                hash: true,
                ..Default::default()
            },
            vec![MigrationHistoryRow {
                id: 1,
                name: Some("0000_first.sql".to_owned()),
                hash: Some(hash_for("0001_second.sql")),
                created_at: None,
            }],
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
    assert_eq!(result.pending_migrations[0].file_name, "0001_second.sql");
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("hash does not match"))
    );
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
            .any(|diagnostic| diagnostic.contains("approved historical replay set"))
    );
}

#[test]
fn name_history_gap_is_rejected_without_an_explicit_replay_allowlist_entry() {
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
fn hash_history_gap_is_rejected_without_an_explicit_replay_allowlist_entry() {
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
fn exact_shipped_historical_migration_gaps_are_source_pinned_pending_work() {
    let replayable = [
        (
            "0044_illegal_toad.sql",
            include_str!("../../../../packages/db/src/migrations/0044_illegal_toad.sql"),
        ),
        (
            "0063_flawless_toad.sql",
            include_str!("../../../../packages/db/src/migrations/0063_flawless_toad.sql"),
        ),
        (
            "0100_mean_richard_fisk.sql",
            include_str!("../../../../packages/db/src/migrations/0100_mean_richard_fisk.sql"),
        ),
        (
            "0102_complex_retro_girl.sql",
            include_str!("../../../../packages/db/src/migrations/0102_complex_retro_girl.sql"),
        ),
        (
            "0103_cute_colonel_america.sql",
            include_str!("../../../../packages/db/src/migrations/0103_cute_colonel_america.sql"),
        ),
    ];

    for (file_name, sql) in replayable {
        let (_root, manifest) = manifest_with_shipped_gap(file_name, sql);
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
                        hash: Some(manifest.entries[0].sha256.clone()),
                        created_at: None,
                    },
                    MigrationHistoryRow {
                        id: 3,
                        name: None,
                        hash: Some(manifest.entries[2].sha256.clone()),
                        created_at: None,
                    },
                ],
            ),
        )
        .unwrap();

        assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
        assert_eq!(result.reason, MigrationHistoryReason::PendingMigrations);
        assert_eq!(result.pending_migrations.len(), 1);
        assert_eq!(result.pending_migrations[0].file_name, file_name);
        assert_eq!(result.pending_migrations[0].sha256, hash_content(sql));
    }
}

#[test]
fn exact_0021_and_0031_gaps_are_internal_catalog_repair_candidates_only() {
    let repairable = [
        (
            "0021_chief_vindicator.sql",
            include_str!("../../../../packages/db/src/migrations/0021_chief_vindicator.sql"),
        ),
        (
            "0031_zippy_magma.sql",
            include_str!("../../../../packages/db/src/migrations/0031_zippy_magma.sql"),
        ),
    ];

    for (file_name, sql) in repairable {
        let (_root, manifest) = manifest_with_shipped_gap(file_name, sql);
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
                        hash: Some(manifest.entries[0].sha256.clone()),
                        created_at: None,
                    },
                    MigrationHistoryRow {
                        id: 3,
                        name: None,
                        hash: Some(manifest.entries[2].sha256.clone()),
                        created_at: None,
                    },
                ],
            ),
        )
        .unwrap();

        assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
        assert_eq!(result.reason, MigrationHistoryReason::PendingMigrations);
        assert_eq!(result.pending_migrations[0].file_name, file_name);
        assert_eq!(result.catalog_repair_candidates.len(), 1);
        assert_eq!(result.catalog_repair_candidates[0].file_name, file_name);
        assert_eq!(
            result.catalog_repair_candidates[0].sha256,
            hash_content(sql)
        );
    }
}

#[test]
fn catalog_repair_rows_appended_to_a_complete_journal_allow_a_new_tail_migration() {
    let (_base_root, base_manifest) = manifest_with_exact_catalog_repair_entries(false);
    let (_upgraded_root, upgraded_manifest) = manifest_with_exact_catalog_repair_entries(true);
    // The first order models repairing both rows in one operation. The second
    // models a later repair wave that appends 0021 after the already-repaired
    // 0031 row. Both are valid historical journal states after these exact
    // catalog proofs have committed.
    for repaired_order in [[0, 2, 4, 1, 3], [0, 2, 4, 3, 1]] {
        let repaired_rows = history_rows_in_manifest_order(&base_manifest, &repaired_order);
        let base = reconcile_migration_history(
            &base_manifest,
            &snapshot(
                MigrationHistoryColumns {
                    id: true,
                    hash: true,
                    created_at: true,
                    ..Default::default()
                },
                repaired_rows.clone(),
            ),
        )
        .unwrap();
        assert_eq!(base.status, MigrationHistoryStatus::UpToDate);
        assert_eq!(base.reason, MigrationHistoryReason::ManifestMatch);

        let upgraded = reconcile_migration_history(
            &upgraded_manifest,
            &snapshot(
                MigrationHistoryColumns {
                    id: true,
                    hash: true,
                    created_at: true,
                    ..Default::default()
                },
                repaired_rows,
            ),
        )
        .unwrap();
        assert_eq!(upgraded.status, MigrationHistoryStatus::NeedsMigrations);
        assert_eq!(upgraded.reason, MigrationHistoryReason::PendingMigrations);
        assert_eq!(upgraded.pending_migrations.len(), 1);
        assert_eq!(
            upgraded.pending_migrations[0].file_name,
            "0050_new_tail.sql"
        );
        assert!(upgraded.diagnostics.is_empty());
        assert!(upgraded.catalog_repair_candidates.is_empty());
    }
}

#[test]
fn name_only_catalog_repair_rows_allow_multiple_repair_waves_and_future_tail() {
    let (_base_root, base_manifest) = manifest_with_exact_catalog_repair_entries(false);
    let (_upgraded_root, upgraded_manifest) = manifest_with_exact_catalog_repair_entries(true);

    for repaired_order in [[0, 2, 4, 1, 3], [0, 2, 4, 3, 1]] {
        let rows = name_only_history_rows_in_manifest_order(&base_manifest, &repaired_order);
        let base = reconcile_migration_history(
            &base_manifest,
            &snapshot(
                MigrationHistoryColumns {
                    id: true,
                    name: true,
                    created_at: true,
                    ..Default::default()
                },
                rows.clone(),
            ),
        )
        .unwrap();
        assert_eq!(base.status, MigrationHistoryStatus::UpToDate, "{base:?}");
        assert_eq!(base.reason, MigrationHistoryReason::ManifestMatch);

        let upgraded = reconcile_migration_history(
            &upgraded_manifest,
            &snapshot(
                MigrationHistoryColumns {
                    id: true,
                    name: true,
                    created_at: true,
                    ..Default::default()
                },
                rows,
            ),
        )
        .unwrap();
        assert_eq!(
            upgraded.status,
            MigrationHistoryStatus::NeedsMigrations,
            "{upgraded:?}"
        );
        assert_eq!(upgraded.reason, MigrationHistoryReason::PendingMigrations);
        assert_eq!(upgraded.pending_migrations.len(), 1);
        assert_eq!(
            upgraded.pending_migrations[0].file_name,
            "0050_new_tail.sql"
        );
        assert!(upgraded.diagnostics.is_empty(), "{upgraded:?}");
        assert!(upgraded.catalog_repair_candidates.is_empty());
    }
}

#[test]
fn hash_column_presence_never_falls_back_to_name_for_null_or_wrong_hash() {
    let sql = include_str!("../../../../packages/db/src/migrations/0021_chief_vindicator.sql");
    let (_root, manifest) = manifest_with_shipped_gap("0021_chief_vindicator.sql", sql);
    let columns = MigrationHistoryColumns {
        id: true,
        name: true,
        hash: true,
        ..Default::default()
    };
    for hash in [None, Some("wrong-hash".to_owned())] {
        let rows = vec![
            MigrationHistoryRow {
                id: 1,
                name: Some(manifest.entries[0].file_name.clone()),
                hash: Some(manifest.entries[0].sha256.clone()),
                created_at: Some(1),
            },
            MigrationHistoryRow {
                id: 3,
                name: Some(manifest.entries[2].file_name.clone()),
                hash,
                created_at: Some(3),
            },
        ];
        let result = reconcile_migration_history(&manifest, &snapshot(columns, rows)).unwrap();
        assert_eq!(
            result.reason,
            MigrationHistoryReason::ManifestMismatch,
            "{result:?}"
        );
        assert!(result.catalog_repair_candidates.is_empty(), "{result:?}");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.contains("migration history hash") }),
            "{result:?}"
        );
    }
}

#[test]
fn name_only_history_rejects_unknown_or_missing_names_before_repair() {
    let sql = include_str!("../../../../packages/db/src/migrations/0021_chief_vindicator.sql");
    let (_root, manifest) = manifest_with_shipped_gap("0021_chief_vindicator.sql", sql);
    let columns = MigrationHistoryColumns {
        id: true,
        name: true,
        ..Default::default()
    };
    for tail_name in [Some("unknown.sql".to_owned()), None] {
        let rows = vec![
            MigrationHistoryRow {
                id: 1,
                name: Some(manifest.entries[0].file_name.clone()),
                hash: None,
                created_at: Some(1),
            },
            MigrationHistoryRow {
                id: 3,
                name: tail_name,
                hash: None,
                created_at: Some(3),
            },
        ];
        let result = reconcile_migration_history(&manifest, &snapshot(columns, rows)).unwrap();
        assert_eq!(
            result.reason,
            MigrationHistoryReason::ManifestMismatch,
            "{result:?}"
        );
        assert!(result.catalog_repair_candidates.is_empty(), "{result:?}");
        assert!(
            result.diagnostics.iter().any(|diagnostic| {
                diagnostic.contains("migration history name does not match the manifest")
            }),
            "{result:?}"
        );
    }
}

#[test]
fn late_0031_row_does_not_hide_the_exact_missing_0021_catalog_candidate() {
    let (_root, manifest) = manifest_with_exact_catalog_repair_entries(false);
    // 0031 sits after ordinary history because it was previously recorded by
    // a catalog repair; all ordinary rows still retain their original order.
    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                hash: true,
                created_at: true,
                ..Default::default()
            },
            history_rows_in_manifest_order(&manifest, &[0, 2, 4, 3]),
        ),
    )
    .unwrap();
    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::PendingMigrations);
    assert_eq!(
        result
            .applied_migrations
            .iter()
            .filter(|entry| entry.file_name != "0031_zippy_magma.sql")
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0000_before.sql", "0030_between.sql", "0040_after.sql"]
    );
    assert_eq!(result.pending_migrations.len(), 1);
    assert_eq!(
        result.pending_migrations[0].file_name,
        "0021_chief_vindicator.sql"
    );
    assert_eq!(result.catalog_repair_candidates.len(), 1);
    assert_eq!(
        result.catalog_repair_candidates[0].file_name,
        "0021_chief_vindicator.sql"
    );
    assert_eq!(
        result.catalog_repair_candidates[0].sha256,
        hash_content(include_str!(
            "../../../../packages/db/src/migrations/0021_chief_vindicator.sql"
        ))
    );
}

#[test]
fn catalog_repair_candidates_are_cleared_for_any_structural_history_conflict() {
    let sql = include_str!("../../../../packages/db/src/migrations/0021_chief_vindicator.sql");
    let (_root, manifest) = manifest_with_shipped_gap("0021_chief_vindicator.sql", sql);
    let columns = MigrationHistoryColumns {
        id: true,
        name: true,
        hash: true,
        ..Default::default()
    };
    let row = |id, name: &str, hash: &str| MigrationHistoryRow {
        id,
        name: Some(name.to_owned()),
        hash: Some(hash.to_owned()),
        created_at: Some(id as i64),
    };

    let clean_tail = [row(
        3,
        &manifest.entries[2].file_name,
        &manifest.entries[2].sha256,
    )];
    let cases = [
        vec![
            row(
                1,
                &manifest.entries[0].file_name,
                &manifest.entries[0].sha256,
            ),
            clean_tail[0].clone(),
            row(4, "unknown.sql", "unknown-hash"),
        ],
        vec![
            row(
                1,
                &manifest.entries[0].file_name,
                &manifest.entries[0].sha256,
            ),
            row(
                2,
                &manifest.entries[0].file_name,
                &manifest.entries[0].sha256,
            ),
            clean_tail[0].clone(),
        ],
        vec![
            row(
                1,
                &manifest.entries[0].file_name,
                &manifest.entries[0].sha256,
            ),
            row(
                3,
                &manifest.entries[2].file_name,
                &manifest.entries[1].sha256,
            ),
        ],
        vec![
            clean_tail[0].clone(),
            row(
                1,
                &manifest.entries[0].file_name,
                &manifest.entries[0].sha256,
            ),
        ],
    ];

    for rows in cases {
        let result = reconcile_migration_history(&manifest, &snapshot(columns, rows)).unwrap();
        assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
        assert!(result.catalog_repair_candidates.is_empty());
    }
}

#[test]
fn historical_0102_alias_maps_to_current_0104_and_allows_exact_0102_0103_gaps() {
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let migrations_dir = repository_root.join("packages/db/src/migrations");
    let manifest = load_migration_manifest(
        &migrations_dir.join("meta/_journal.json"),
        &migrations_dir,
        MigrationLimits::default(),
    )
    .unwrap();
    let legacy_0104_hash = "a1fc0446af5ec1640890bb9cf36208eab8dce6687c233029bd54e179613e1af7";
    let current_0104 = manifest
        .entries
        .iter()
        .find(|entry| entry.file_name == "0104_unusual_mister_fear.sql")
        .unwrap();
    assert_eq!(current_0104.sha256, legacy_0104_hash);

    let mut rows = manifest
        .entries
        .iter()
        .filter_map(|entry| {
            let journal = entry.journal_entry.as_ref()?;
            (journal.idx < 102).then(|| MigrationHistoryRow {
                id: u64::try_from(journal.idx).unwrap() + 1,
                name: None,
                hash: Some(entry.sha256.clone()),
                created_at: Some(i64::try_from(journal.when).unwrap()),
            })
        })
        .collect::<Vec<_>>();
    rows.push(MigrationHistoryRow {
        id: 103,
        name: None,
        hash: Some(legacy_0104_hash.to_owned()),
        created_at: Some(1_784_159_513_933),
    });

    let result = reconcile_migration_history(
        &manifest,
        &snapshot(
            MigrationHistoryColumns {
                id: true,
                hash: true,
                created_at: true,
                ..Default::default()
            },
            rows,
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::PendingMigrations);
    assert!(result.diagnostics.is_empty());
    assert!(result.applied_migrations.iter().any(|entry| {
        entry.file_name == "0104_unusual_mister_fear.sql"
            && entry.hash.as_deref() == Some(legacy_0104_hash)
    }));
    assert!(
        result
            .pending_migrations
            .iter()
            .any(|entry| { entry.file_name == "0102_complex_retro_girl.sql" })
    );
    assert!(
        result
            .pending_migrations
            .iter()
            .any(|entry| { entry.file_name == "0103_cute_colonel_america.sql" })
    );
    assert!(
        !result
            .pending_migrations
            .iter()
            .any(|entry| { entry.file_name == "0104_unusual_mister_fear.sql" })
    );
    assert!(
        result
            .pending_migrations
            .iter()
            .any(|entry| { entry.file_name == "0055_illegal_sheva_callister.sql" })
    );
}

#[test]
fn complete_current_hash_set_still_rejects_ordinary_journal_reordering() {
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
                    hash: Some(hash_for("0002_third.sql")),
                    created_at: None,
                },
                MigrationHistoryRow {
                    id: 2,
                    name: None,
                    hash: Some(hash_for("0000_first.sql")),
                    created_at: None,
                },
                MigrationHistoryRow {
                    id: 3,
                    name: None,
                    hash: Some(hash_for("0001_second.sql")),
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
    assert!(result.diagnostics.iter().any(|diagnostic| {
        diagnostic.contains("migration history order does not match manifest order")
    }));
    assert!(result.pending_migrations.is_empty());
}

fn legacy_tail_snapshot(names: &[&str], use_names: bool) -> MigrationHistorySnapshot {
    snapshot(
        MigrationHistoryColumns {
            id: true,
            name: use_names,
            hash: true,
            ..Default::default()
        },
        names
            .iter()
            .enumerate()
            .map(|(index, name)| MigrationHistoryRow {
                id: index as u64 + 1,
                name: use_names.then(|| (*name).to_owned()),
                hash: Some(hash_for(name)),
                created_at: None,
            })
            .collect(),
    )
}

#[test]
fn applied_legacy_tail_does_not_hide_the_next_journaled_migration() {
    let (_root, manifest) = manifest_with_legacy_tail(
        &["0000_first.sql", "0001_second.sql", "0002_third.sql"],
        &[
            "0055_illegal_sheva_callister.sql",
            "0128_modern_jetstream.sql",
        ],
    );
    for use_names in [false, true] {
        let mut names = vec![
            "0000_first.sql",
            "0001_second.sql",
            "0055_illegal_sheva_callister.sql",
            "0128_modern_jetstream.sql",
        ];
        let pending =
            reconcile_migration_history(&manifest, &legacy_tail_snapshot(&names, use_names))
                .unwrap();
        assert_eq!(pending.reason, MigrationHistoryReason::PendingMigrations);
        assert_eq!(pending.applied_migrations.len(), 4);
        assert_eq!(pending.pending_migrations.len(), 1);
        assert_eq!(pending.pending_migrations[0].file_name, "0002_third.sql");
        assert_eq!(
            pending.pending_migrations[0].sha256,
            hash_for("0002_third.sql")
        );
        assert!(pending.diagnostics.is_empty());

        // The ordinary applier records the new journal entry after the legacy
        // rows already retained from the predecessor. Its journal is current.
        names.push("0002_third.sql");
        let current =
            reconcile_migration_history(&manifest, &legacy_tail_snapshot(&names, use_names))
                .unwrap();
        assert_eq!(current.status, MigrationHistoryStatus::UpToDate);
        assert_eq!(current.reason, MigrationHistoryReason::ManifestMatch);
        assert_eq!(current.applied_migrations.len(), 5);
        assert!(current.pending_migrations.is_empty());
        assert!(current.diagnostics.is_empty());
    }
}

#[test]
fn applied_legacy_tail_rejects_unreviewed_gaps_and_complete_reordering() {
    let (_root, manifest) = manifest_with_legacy_tail(
        &["0000_first.sql", "0001_second.sql", "0002_third.sql"],
        &[
            "0055_illegal_sheva_callister.sql",
            "0128_modern_jetstream.sql",
        ],
    );
    for names in [
        vec![
            "0000_first.sql",
            "0002_third.sql",
            "0055_illegal_sheva_callister.sql",
            "0128_modern_jetstream.sql",
        ],
        vec![
            "0001_second.sql",
            "0055_illegal_sheva_callister.sql",
            "0000_first.sql",
            "0128_modern_jetstream.sql",
            "0002_third.sql",
        ],
    ] {
        let result =
            reconcile_migration_history(&manifest, &legacy_tail_snapshot(&names, false)).unwrap();
        assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
        assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.contains("migration history order does not match manifest order")
                || diagnostic.contains("migration history contains a gap")
        }));
        if names.contains(&"0002_third.sql") && !names.contains(&"0001_second.sql") {
            assert_eq!(result.pending_migrations.len(), 1);
            assert_eq!(result.pending_migrations[0].file_name, "0001_second.sql");
        } else {
            assert!(result.pending_migrations.is_empty());
        }
    }
}

#[test]
fn applied_legacy_tail_still_rejects_duplicate_history() {
    let (_root, manifest) =
        manifest_with_legacy_tail(&["0000_first.sql"], &["0055_illegal_sheva_callister.sql"]);
    let result = reconcile_migration_history(
        &manifest,
        &legacy_tail_snapshot(
            &[
                "0000_first.sql",
                "0055_illegal_sheva_callister.sql",
                "0055_illegal_sheva_callister.sql",
            ],
            false,
        ),
    )
    .unwrap();
    assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
}

#[test]
fn duplicate_current_migration_identity_still_fails_closed() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql"]);
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
                    id: 2,
                    name: None,
                    hash: Some(hash_for("0000_first.sql")),
                    created_at: None,
                },
            ],
        ),
    )
    .unwrap();

    assert_eq!(result.status, MigrationHistoryStatus::NeedsMigrations);
    assert_eq!(result.reason, MigrationHistoryReason::ManifestMismatch);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("repeats a manifest migration"))
    );
}

#[test]
fn duplicate_history_ids_are_invalid_even_when_hashes_form_a_complete_set() {
    let (_root, manifest) = manifest(&["0000_first.sql", "0001_second.sql"]);
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
                    created_at: Some(1),
                },
                MigrationHistoryRow {
                    id: 1,
                    name: None,
                    hash: Some(hash_for("0001_second.sql")),
                    created_at: Some(2),
                },
            ],
        ),
    );

    assert_eq!(
        result.unwrap_err(),
        rudder_migration_history_core::MigrationHistoryError::HistoryRowInvalid(
            "row 1 id must be unique".to_owned()
        )
    );
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
                    hash: Some("legacy-0100-hash".to_owned()),
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
