use rudder_migration_core::{
    JournalEntry, MigrationJournal, MigrationLimits, MigrationManifestOptions,
};
use rudder_migration_runner::{
    MigrationRunRequest, MigrationRunStatus, MigrationRunner, MigrationRunnerConfig,
    MigrationSource, SqlxMigrationExecutor, SqlxMigrationExecutorConfig,
};
use sqlx::postgres::PgPoolOptions;
use std::env;
use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tempfile::tempdir;

fn limits() -> MigrationLimits {
    MigrationLimits {
        max_journal_bytes: 64 * 1024,
        max_sql_file_bytes: 64 * 1024,
        max_total_sql_bytes: 256 * 1024,
        max_sql_files: 32,
        max_directory_entries: 64,
    }
}

fn source(root: &std::path::Path) -> MigrationSource {
    let migrations = root.join("migrations");
    let meta = migrations.join("meta");
    fs::create_dir_all(&meta).unwrap();
    fs::write(
        migrations.join("0000_runner_marker.sql"),
        "CREATE TABLE runner_marker (id integer NOT NULL);",
    )
    .unwrap();
    let journal = MigrationJournal {
        version: "7".into(),
        dialect: "postgresql".into(),
        entries: vec![JournalEntry {
            idx: 0,
            version: "7".into(),
            when: 1_000,
            tag: "0000_runner_marker".into(),
            breakpoints: false,
        }],
    };
    let journal_path = meta.join("_journal.json");
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    MigrationSource::new(
        journal_path,
        migrations,
        MigrationManifestOptions {
            limits: limits(),
            legacy_unjournaled: Vec::new(),
        },
    )
}

fn request(candidate: MigrationSource) -> MigrationRunRequest {
    MigrationRunRequest {
        candidate,
        baseline: None,
        recovery: None,
    }
}

#[tokio::test]
#[ignore = "requires RUDDER_MIGRATION_RUNNER_TEST_DATABASE_URL pointing at a disposable empty PostgreSQL database"]
async fn applies_and_rereads_drizzle_history_in_a_disposable_schema() {
    let url = env::var("RUDDER_MIGRATION_RUNNER_TEST_DATABASE_URL")
        .expect("set RUDDER_MIGRATION_RUNNER_TEST_DATABASE_URL for this ignored test");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .unwrap();
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let schema = format!("migration_runner_it_{}_{}", std::process::id(), suffix);
    let history_table = format!("\"{schema}\".\"__drizzle_migrations\"");
    let marker_table = format!("\"{schema}\".\"runner_marker\"");
    let root = tempdir().unwrap();
    let candidate = source(root.path());
    let executor = SqlxMigrationExecutor::with_config(
        pool.clone(),
        SqlxMigrationExecutorConfig {
            history_schema: schema.clone(),
            history_table: "__drizzle_migrations".into(),
            search_path: vec![schema.clone()],
            lock_poll_interval: Duration::from_millis(5),
        },
    )
    .unwrap();
    let config = MigrationRunnerConfig {
        lock_name: format!("rudder.migration-runner.integration.{suffix}"),
        lock_timeout: Duration::from_secs(5),
        ..MigrationRunnerConfig::default()
    };
    let mut runner = MigrationRunner::new(executor, config);

    let first = runner.run(request(candidate.clone())).await.unwrap();
    assert_eq!(first.status, MigrationRunStatus::Applied);
    assert_eq!(first.applied_entries.len(), 1);
    assert!(first.transaction.committed);
    assert!(first.lock.released);

    let history_count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {history_table}"))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(history_count, 1);
    let marker_exists: bool =
        sqlx::query_scalar(&format!("SELECT EXISTS (SELECT 1 FROM {marker_table})"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(marker_exists);

    let second = runner.run(request(candidate)).await.unwrap();
    assert_eq!(second.status, MigrationRunStatus::AlreadyCurrent);
    assert!(second.applied_entries.is_empty());
    assert!(second.transaction.committed);
    assert!(!second.recovery.required);
    assert!(second.lock.released);

    drop(runner);
    sqlx::query(&format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
