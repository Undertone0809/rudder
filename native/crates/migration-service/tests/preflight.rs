use rudder_migration_core::{MigrationLimits, MigrationManifest, load_migration_manifest};
use rudder_migration_history_core::{
    MigrationHistoryColumns, MigrationHistoryPreflight, MigrationHistoryReason,
    MigrationHistoryRow, MigrationHistorySnapshot, MigrationHistoryStatus,
    reconcile_migration_history,
};
use rudder_migration_service::{
    MigrationPreflightDatabaseState, MigrationPreflightStatus, classify_preflight,
};
use std::fs::{create_dir_all, write};
use tempfile::TempDir;

fn manifest_fixture() -> (TempDir, MigrationManifest) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    create_dir_all(&meta).unwrap();
    for name in ["0000_first.sql", "0001_second.sql", "0002_third.sql"] {
        write(migrations.join(name), name.as_bytes()).unwrap();
    }
    write(
        meta.join("_journal.json"),
        r#"{"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1000,"tag":"0000_first","breakpoints":true},{"idx":1,"version":"7","when":1001,"tag":"0001_second","breakpoints":true},{"idx":2,"version":"7","when":1002,"tag":"0002_third","breakpoints":true}]}"#,
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

fn history(reason: MigrationHistoryReason) -> MigrationHistoryPreflight {
    MigrationHistoryPreflight {
        status: if reason == MigrationHistoryReason::ManifestMatch {
            MigrationHistoryStatus::UpToDate
        } else {
            MigrationHistoryStatus::NeedsMigrations
        },
        reason,
        manifest_fingerprint: "fixture".to_owned(),
        migration_table_schema: None,
        journal_entry_count: 0,
        applied_migrations: Vec::new(),
        pending_migrations: Vec::new(),
        diagnostics: Vec::new(),
    }
}

fn snapshot(schema: Option<&str>) -> MigrationHistorySnapshot {
    MigrationHistorySnapshot {
        table_schema: schema.map(str::to_owned),
        columns: MigrationHistoryColumns::default(),
        rows: Vec::new(),
    }
}

#[test]
fn report_preserves_ordered_plan_and_manifest_fingerprint() {
    let (_root, manifest) = manifest_fixture();
    let snapshot = MigrationHistorySnapshot {
        table_schema: Some("drizzle".to_owned()),
        columns: MigrationHistoryColumns {
            id: true,
            hash: true,
            created_at: true,
            ..Default::default()
        },
        rows: manifest
            .entries
            .iter()
            .take(2)
            .enumerate()
            .map(|(index, entry)| MigrationHistoryRow {
                id: (index + 1) as u64,
                name: None,
                hash: Some(entry.sha256.clone()),
                created_at: Some(1_000 + index as i64),
            })
            .collect(),
    };
    let history = reconcile_migration_history(&manifest, &snapshot).unwrap();
    let report = classify_preflight(
        &snapshot,
        history,
        MigrationPreflightDatabaseState {
            table_count: 3,
            core_schema_present: true,
            organizations_table_present: true,
        },
    );

    assert_eq!(report.history.manifest_fingerprint, manifest.fingerprint);
    assert_eq!(
        report
            .history
            .applied_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0000_first.sql", "0001_second.sql"]
    );
    assert_eq!(
        report
            .history
            .pending_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0002_third.sql"]
    );
}

#[test]
fn state_matrix_preserves_read_only_boundaries() {
    let cases = [
        (
            snapshot(None),
            history(MigrationHistoryReason::MigrationJournalMissing),
            MigrationPreflightDatabaseState {
                table_count: 0,
                core_schema_present: true,
                organizations_table_present: false,
            },
            MigrationPreflightStatus::Bootstrap,
        ),
        (
            snapshot(None),
            history(MigrationHistoryReason::MigrationJournalMissing),
            MigrationPreflightDatabaseState {
                table_count: 1,
                core_schema_present: true,
                organizations_table_present: false,
            },
            MigrationPreflightStatus::UnsafeLegacy,
        ),
        (
            snapshot(Some("drizzle")),
            history(MigrationHistoryReason::PendingMigrations),
            MigrationPreflightDatabaseState {
                table_count: 2,
                core_schema_present: true,
                organizations_table_present: true,
            },
            MigrationPreflightStatus::Pending,
        ),
        (
            snapshot(Some("drizzle")),
            history(MigrationHistoryReason::ManifestMismatch),
            MigrationPreflightDatabaseState {
                table_count: 2,
                core_schema_present: true,
                organizations_table_present: true,
            },
            MigrationPreflightStatus::Mismatch,
        ),
        (
            snapshot(Some("drizzle")),
            history(MigrationHistoryReason::ManifestMatch),
            MigrationPreflightDatabaseState {
                table_count: 2,
                core_schema_present: true,
                organizations_table_present: true,
            },
            MigrationPreflightStatus::Current,
        ),
        (
            snapshot(None),
            history(MigrationHistoryReason::MigrationJournalMissing),
            MigrationPreflightDatabaseState {
                table_count: 0,
                core_schema_present: false,
                organizations_table_present: false,
            },
            MigrationPreflightStatus::Bootstrap,
        ),
        (
            snapshot(Some("drizzle")),
            history(MigrationHistoryReason::PendingMigrations),
            MigrationPreflightDatabaseState {
                table_count: 2,
                core_schema_present: false,
                organizations_table_present: false,
            },
            MigrationPreflightStatus::Pending,
        ),
    ];

    for (snapshot, history, database, expected) in cases {
        assert_eq!(
            classify_preflight(&snapshot, history, database).status,
            expected
        );
    }
}
