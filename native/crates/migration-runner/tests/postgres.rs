use rudder_migration_core::{
    JournalEntry, MigrationJournal, MigrationLimits, MigrationManifestOptions,
};
use rudder_migration_runner::{
    MigrationRunRequest, MigrationRunStatus, MigrationRunner, MigrationRunnerConfig,
    MigrationSource, RecoveryPoint, SqlxMigrationExecutor, SqlxMigrationExecutorConfig,
    SqlxMigrationExecutorError,
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
    source_with_sql(root, "CREATE TABLE runner_marker (id integer NOT NULL);")
}

fn source_with_sql(root: &std::path::Path, sql: &str) -> MigrationSource {
    let migrations = root.join("migrations");
    let meta = migrations.join("meta");
    fs::create_dir_all(&meta).unwrap();
    fs::write(migrations.join("0000_runner_marker.sql"), sql).unwrap();
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

fn valid_recovery() -> RecoveryPoint {
    RecoveryPoint {
        created: true,
        includes_migration_journal: true,
        path: Some("/disposable/pre-migration.sql".into()),
    }
}

#[tokio::test]
async fn rejects_unvalidated_postgres_identifiers_before_database_access() {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://localhost/test")
        .unwrap();

    let config = SqlxMigrationExecutorConfig {
        history_schema: "history;drop".into(),
        ..SqlxMigrationExecutorConfig::default()
    };
    assert!(matches!(
        SqlxMigrationExecutor::with_config(pool.clone(), config),
        Err(SqlxMigrationExecutorError::InvalidIdentifier(_))
    ));

    let config = SqlxMigrationExecutorConfig {
        history_table: "history table".into(),
        ..SqlxMigrationExecutorConfig::default()
    };
    assert!(matches!(
        SqlxMigrationExecutor::with_config(pool.clone(), config),
        Err(SqlxMigrationExecutorError::InvalidIdentifier(_))
    ));

    let config = SqlxMigrationExecutorConfig {
        search_path: vec!["tenant\".public".into()],
        ..SqlxMigrationExecutorConfig::default()
    };
    assert!(matches!(
        SqlxMigrationExecutor::with_config(pool, config),
        Err(SqlxMigrationExecutorError::InvalidIdentifier(_))
    ));
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
    let history_schema = format!("migration_runner_history_{}_{}", std::process::id(), suffix);
    let migration_schema = format!("migration_runner_sql_{}_{}", std::process::id(), suffix);
    let history_table = format!("\"{history_schema}\".\"__drizzle_migrations\"");
    let marker_table = format!("\"{migration_schema}\".\"runner_marker\"");
    sqlx::query(&format!("CREATE SCHEMA \"{migration_schema}\""))
        .execute(&pool)
        .await
        .unwrap();
    let root = tempdir().unwrap();
    let candidate = source(root.path());
    let executor = SqlxMigrationExecutor::with_config(
        pool.clone(),
        SqlxMigrationExecutorConfig {
            history_schema: history_schema.clone(),
            history_table: "__drizzle_migrations".into(),
            search_path: vec![migration_schema.clone()],
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
    sqlx::query(&format!(
        "DROP SCHEMA IF EXISTS \"{migration_schema}\" CASCADE"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "DROP SCHEMA IF EXISTS \"{history_schema}\" CASCADE"
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires RUDDER_MIGRATION_RUNNER_TEST_DATABASE_URL pointing at a disposable empty PostgreSQL database"]
async fn defaults_search_path_to_the_configured_history_schema() {
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
    let schema = format!("migration_runner_default_{}_{}", std::process::id(), suffix);
    let marker = format!("runner_default_marker_{suffix}");
    let root = tempdir().unwrap();
    let candidate = source_with_sql(
        root.path(),
        &format!("CREATE TABLE {marker} (id integer NOT NULL);"),
    );
    let executor = SqlxMigrationExecutor::with_config(
        pool.clone(),
        SqlxMigrationExecutorConfig {
            history_schema: schema.clone(),
            history_table: "__drizzle_migrations".into(),
            search_path: Vec::new(),
            lock_poll_interval: Duration::from_millis(5),
        },
    )
    .unwrap();
    let mut runner = MigrationRunner::new(
        executor,
        MigrationRunnerConfig {
            lock_name: format!("rudder.migration-runner.default-search-path.{suffix}"),
            lock_timeout: Duration::from_secs(5),
            ..MigrationRunnerConfig::default()
        },
    );

    let receipt = runner.run(request(candidate)).await.unwrap();
    assert_eq!(receipt.status, MigrationRunStatus::Applied);
    let marker_exists: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM \"{schema}\".\"{marker}\")"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(marker_exists);
    let public_marker_exists: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '{marker}')"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!public_marker_exists);

    drop(runner);
    sqlx::query(&format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires RUDDER_MIGRATION_RUNNER_TEST_DATABASE_URL pointing at a disposable empty PostgreSQL database"]
async fn refuses_history_table_discovered_in_an_arbitrary_tenant_schema() {
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
    let configured_schema = format!(
        "migration_runner_configured_{}_{}",
        std::process::id(),
        suffix
    );
    let tenant_schema = format!("migration_runner_tenant_{}_{}", std::process::id(), suffix);
    sqlx::query(&format!("CREATE SCHEMA \"{tenant_schema}\""))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TABLE \"{tenant_schema}\".\"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text NOT NULL)"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let root = tempdir().unwrap();
    let candidate = source(root.path());
    let manifest = candidate.load().unwrap().manifest;
    sqlx::query(&format!(
        "INSERT INTO \"{tenant_schema}\".\"__drizzle_migrations\" (hash, created_at, name) VALUES ($1, $2, $3)"
    ))
    .bind(&manifest.entries[0].sha256)
    .bind(1_i64)
    .bind(&manifest.entries[0].file_name)
    .execute(&pool)
    .await
    .unwrap();
    let executor = SqlxMigrationExecutor::with_config(
        pool.clone(),
        SqlxMigrationExecutorConfig {
            history_schema: configured_schema.clone(),
            history_table: "__drizzle_migrations".into(),
            search_path: vec![configured_schema.clone()],
            lock_poll_interval: Duration::from_millis(5),
        },
    )
    .unwrap();
    let mut runner = MigrationRunner::new(
        executor,
        MigrationRunnerConfig {
            lock_name: format!("rudder.migration-runner.arbitrary-schema.{suffix}"),
            lock_timeout: Duration::from_secs(5),
            ..MigrationRunnerConfig::default()
        },
    );

    let error = runner
        .run(MigrationRunRequest {
            candidate,
            baseline: None,
            recovery: Some(valid_recovery()),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code(), "migration_history_missing");
    let receipt = error.receipt().unwrap();
    assert!(receipt.transaction.rolled_back);
    assert!(receipt.lock.released);
    let configured_schema_exists: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '{configured_schema}')"
    ))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!configured_schema_exists);

    drop(runner);
    sqlx::query(&format!(
        "DROP SCHEMA IF EXISTS \"{tenant_schema}\" CASCADE"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "DROP SCHEMA IF EXISTS \"{configured_schema}\" CASCADE"
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;
}
