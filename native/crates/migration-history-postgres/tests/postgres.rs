use rudder_migration_core::{MigrationLimits, MigrationManifest, load_migration_manifest};
use rudder_migration_history_core::{MigrationHistoryReason, MigrationHistoryStatus};
use rudder_migration_history_postgres::{
    MAX_MIGRATION_HISTORY_ROWS, MigrationHistoryPostgres, MigrationHistoryPostgresError,
};
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
    format!("migration_history_{}_{}", std::process::id(), nanos)
}

#[tokio::test]
#[ignore = "requires RUDDER_MIGRATION_HISTORY_POSTGRES_TEST_DATABASE_URL"]
async fn reads_history_in_one_read_only_transaction_and_reconciles_it()
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
    let first_hash = &manifest.entries[0].sha256;
    let second_hash = &manifest.entries[1].sha256;
    sqlx::query(&format!(
        r#"INSERT INTO {table} ("id", "hash", "created_at") VALUES ($1, $2, $3)"#
    ))
    .bind(2_i32)
    .bind(second_hash)
    .bind(1_001_i64)
    .execute(&pool)
    .await?;
    sqlx::query(&format!(
        r#"INSERT INTO {table} ("id", "hash", "created_at") VALUES ($1, $2, $3)"#
    ))
    .bind(1_i32)
    .bind(first_hash)
    .bind(1_000_i64)
    .execute(&pool)
    .await?;

    let reader = MigrationHistoryPostgres::new(pool.clone());
    let snapshot = reader.read_snapshot().await?;
    assert_eq!(snapshot.table_schema.as_deref(), Some(schema.as_str()));
    assert_eq!(
        snapshot.rows.iter().map(|row| row.id).collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(snapshot.columns.id);
    assert!(snapshot.columns.hash);
    assert!(snapshot.columns.created_at);

    let preflight = reader.preflight(&manifest).await?;
    assert_eq!(preflight.status, MigrationHistoryStatus::UpToDate);
    assert_eq!(preflight.reason, MigrationHistoryReason::ManifestMatch);
    assert_eq!(preflight.applied_migrations.len(), 2);
    let repeated = reader.read_snapshot().await?;
    assert_eq!(repeated.rows, snapshot.rows);

    sqlx::query(&format!(
        r#"UPDATE {table} SET "hash" = repeat('x', $1) WHERE "id" = 1"#
    ))
    .bind(256 * 1024 + 1_i32)
    .execute(&pool)
    .await?;
    assert!(matches!(
        reader.read_snapshot().await,
        Err(MigrationHistoryPostgresError::Conversion { column: "hash", .. })
    ));

    sqlx::query(&format!(r#"DELETE FROM {table}"#))
        .execute(&pool)
        .await?;
    sqlx::query(&format!(
        r#"INSERT INTO {table} ("id", "hash", "created_at") SELECT generate_series(1, $1), 'hash', generate_series(1, $1)"#
    ))
    .bind((MAX_MIGRATION_HISTORY_ROWS + 1) as i32)
    .execute(&pool)
    .await?;
    assert!(matches!(
        reader.read_snapshot().await,
        Err(MigrationHistoryPostgresError::RowLimitExceeded { limit })
            if limit == MAX_MIGRATION_HISTORY_ROWS
    ));

    sqlx::query(&format!(r#"DROP SCHEMA "{schema}" CASCADE"#))
        .execute(&pool)
        .await?;
    pool.close().await;
    Ok(())
}
