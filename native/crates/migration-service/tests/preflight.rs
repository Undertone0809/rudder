use rudder_migration_history_core::{
    MigrationHistoryColumns, MigrationHistoryPreflight, MigrationHistoryReason,
    MigrationHistorySnapshot, MigrationHistoryStatus,
};
use rudder_migration_service::{
    MigrationPreflightDatabaseState, MigrationPreflightStatus, classify_preflight,
};

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
