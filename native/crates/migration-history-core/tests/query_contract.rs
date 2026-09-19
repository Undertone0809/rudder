use rudder_migration_history_core::{MigrationHistoryColumns, query};

#[test]
fn query_contract_is_select_only() {
    assert!(
        query::DISCOVER_SCHEMA_SELECT
            .trim_start()
            .starts_with("SELECT")
    );
    assert!(
        query::DISCOVER_COLUMNS_SELECT
            .trim_start()
            .starts_with("SELECT")
    );
    let statement = query::migration_history_rows_select(
        "drizzle",
        MigrationHistoryColumns {
            id: true,
            name: true,
            hash: true,
            created_at: true,
        },
    )
    .unwrap();
    assert!(statement.starts_with("SELECT"));
    assert!(statement.contains("\"drizzle\".\"__drizzle_migrations\""));
    assert!(!statement.contains("INSERT"));
    assert!(!statement.contains("UPDATE"));
    assert!(!statement.contains("DELETE"));
    assert!(!statement.contains("ALTER"));
    assert!(!statement.contains("DROP"));
}

#[test]
fn query_contract_rejects_unsafe_schema_identifiers() {
    let error = query::migration_history_rows_select(
        "drizzle\"; DROP TABLE users; --",
        MigrationHistoryColumns {
            id: true,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("unsafe-identifier"));
}
