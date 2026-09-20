use rudder_migration_core::{MigrationLimits, MigrationManifest, load_migration_manifest};
use rudder_migration_history_core::{MigrationHistoryReason, MigrationHistoryStatus};
use rudder_migration_history_postgres::begin_read_only_transaction;
use rudder_migration_service::{MigrationPreflightService, MigrationPreflightStatus};
use sqlx::postgres::PgPoolOptions;
use std::{
    env, fs,
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;

fn manifest_fixture() -> (TempDir, MigrationManifest) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    fs::create_dir_all(&meta).unwrap();
    fs::write(migrations.join("0000_first.sql"), "first migration").unwrap();
    fs::write(migrations.join("0001_second.sql"), "second migration").unwrap();
    fs::write(
        meta.join("_journal.json"),
        r#"{"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1000,"tag":"0000_first","breakpoints":true},{"idx":1,"version":"7","when":1001,"tag":"0001_second","breakpoints":true}]}"#,
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

fn unique_schema() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("migration_service_{}_{}", std::process::id(), nanos)
}

#[tokio::test]
#[ignore = "requires RUDDER_MIGRATION_HISTORY_POSTGRES_TEST_DATABASE_URL"]
async fn preflight_reads_history_and_schema_from_one_read_only_snapshot()
-> Result<(), Box<dyn std::error::Error>> {
    let url = env::var("RUDDER_MIGRATION_HISTORY_POSTGRES_TEST_DATABASE_URL")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await?;
    let schema = unique_schema();
    let table = format!(r#""{schema}"."__drizzle_migrations""#);
    sqlx::query(&format!(r#"CREATE SCHEMA "{schema}""#))
        .execute(&pool)
        .await?;
    sqlx::query(&format!(
        r#"CREATE TABLE {table} ("id" integer NOT NULL, "hash" text, "created_at" bigint)"#
    ))
    .execute(&pool)
    .await?;

    let (_root, manifest) = manifest_fixture();
    for (id, entry) in manifest.entries.iter().take(1).enumerate() {
        sqlx::query(&format!(
            r#"INSERT INTO {table} ("id", "hash", "created_at") VALUES ($1, $2, $3)"#
        ))
        .bind((id + 1) as i32)
        .bind(&entry.sha256)
        .bind(1_000_i64 + id as i64)
        .execute(&pool)
        .await?;
    }

    let report = MigrationPreflightService::new(pool.clone())
        .preflight(&manifest)
        .await?;
    assert!(report.journal_present);
    assert_eq!(report.journal_schema.as_deref(), Some(schema.as_str()));
    assert_eq!(report.history.manifest_fingerprint, manifest.fingerprint);
    assert_eq!(
        report.history.status,
        MigrationHistoryStatus::NeedsMigrations
    );
    assert_eq!(
        report.history.reason,
        MigrationHistoryReason::PendingMigrations
    );
    assert_eq!(
        report
            .history
            .applied_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0000_first.sql"]
    );
    assert_eq!(
        report
            .history
            .pending_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0001_second.sql"]
    );
    sqlx::query(&format!(
        r#"INSERT INTO {table} ("id", "hash", "created_at") VALUES ($1, $2, $3)"#
    ))
    .bind(2_i32)
    .bind(&manifest.entries[1].sha256)
    .bind(1_001_i64)
    .execute(&pool)
    .await?;

    let report = MigrationPreflightService::new(pool.clone())
        .preflight(&manifest)
        .await?;
    assert_eq!(report.history.manifest_fingerprint, manifest.fingerprint);
    assert_eq!(report.history.reason, MigrationHistoryReason::ManifestMatch);
    assert_eq!(
        report
            .history
            .applied_migrations
            .iter()
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        ["0000_first.sql", "0001_second.sql"]
    );
    assert!(report.history.pending_migrations.is_empty());
    assert!(matches!(
        report.status,
        MigrationPreflightStatus::Current | MigrationPreflightStatus::MissingCoreSchema
    ));

    let mut read_only_transaction = begin_read_only_transaction(&pool).await?;
    let write_error = sqlx::query(&format!(
        r#"CREATE TABLE "{schema}"."preflight_write_probe" ("id" integer)"#
    ))
    .execute(&mut *read_only_transaction)
    .await
    .expect_err("preflight transaction must remain read-only");
    assert!(write_error.to_string().contains("read-only"));
    read_only_transaction.rollback().await?;

    sqlx::query(&format!(r#"DROP SCHEMA "{schema}" CASCADE"#))
        .execute(&pool)
        .await?;
    pool.close().await;
    Ok(())
}
