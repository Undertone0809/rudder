use rudder_migration_core::{
    MigrationLimits, MigrationManifest, MigrationSource, load_migration_manifest,
};
use rudder_migration_service::{
    MigrationApplyError, MigrationApplyService, MigrationRecoveryPointReceipt,
    NODE_MIGRATION_ADVISORY_LOCK_NAME,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgConnectOptions, postgres::PgPoolOptions};
use std::{
    fs,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;

static DATABASE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

const ADMIN_URL_ENV: &str = "RUDDER_MIGRATION_SERVICE_TEST_ADMIN_URL";
const TEST_RECOVERY_DUMP: &[u8] = b"-- Rudder database backup\n--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\nCREATE SCHEMA drizzle;\nCREATE TABLE drizzle.__drizzle_migrations (\n    id integer NOT NULL,\n    hash text NOT NULL,\n    created_at bigint\n);\nCOPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;\n1\tabc\t1000\n\\.\n--\n-- PostgreSQL database dump complete\n--\n";

struct DisposableDatabase {
    admin_pool: PgPool,
    name: String,
    pool: PgPool,
}

impl DisposableDatabase {
    async fn create() -> Self {
        let admin_url = std::env::var(ADMIN_URL_ENV).unwrap_or_else(|_| {
            panic!("{ADMIN_URL_ENV} must point to the disposable local PostgreSQL cluster")
        });
        let options = PgConnectOptions::from_str(&admin_url)
            .unwrap_or_else(|error| panic!("invalid {ADMIN_URL_ENV}: {error}"));
        let admin_pool = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(options.clone())
            .await
            .unwrap_or_else(|error| panic!("could not connect to disposable PostgreSQL: {error}"));
        let identity = sqlx::query(
            "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address",
        )
        .fetch_one(&admin_pool)
        .await
        .expect("could not verify disposable PostgreSQL identity");
        let database_name: String = identity.try_get("database_name").unwrap();
        let server_address: Option<String> = identity.try_get("server_address").unwrap();
        assert_eq!(
            database_name, "postgres",
            "admin URL must select postgres only"
        );
        assert!(
            server_address
                .as_deref()
                .and_then(|address| address.split('/').next())
                .is_some_and(|address| address == "::1" || address.starts_with("127.")),
            "admin URL must target a loopback-only disposable cluster"
        );

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch")
            .as_nanos();
        // Wall-clock resolution can repeat across concurrent test workers.
        let sequence = DATABASE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "rudder_test_migration_{}_{}_{}",
            std::process::id(),
            nonce,
            sequence
        );
        sqlx::query(&format!("CREATE DATABASE \"{name}\""))
            .execute(&admin_pool)
            .await
            .expect("could not create disposable test database");
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect_with(options.database(&name))
            .await
            .expect("could not connect to disposable test database");
        Self {
            admin_pool,
            name,
            pool,
        }
    }

    async fn cleanup(self) {
        self.pool.close().await;
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
            self.name
        ))
        .execute(&self.admin_pool)
        .await
        .expect("could not drop disposable test database");
        self.admin_pool.close().await;
    }
}

struct PendingMigrationFixture {
    _source_dir: TempDir,
    source: MigrationSource,
    manifest: MigrationManifest,
    backup_dir: TempDir,
    receipt: MigrationRecoveryPointReceipt,
}

impl PendingMigrationFixture {
    fn new() -> Self {
        Self::with_sql("CREATE TABLE public.rust_apply_test (id integer PRIMARY KEY);")
    }

    fn with_sql(sql: &str) -> Self {
        let source_dir =
            tempfile::tempdir().expect("could not create temporary migrations directory");
        let migrations = source_dir.path().join("migrations");
        fs::create_dir_all(migrations.join("meta")).unwrap();
        fs::write(migrations.join("0000_test_apply.sql"), sql).unwrap();
        fs::write(
            migrations.join("meta/_journal.json"),
            r#"{"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1000,"tag":"0000_test_apply","breakpoints":true}]}"#,
        )
        .unwrap();
        let source = MigrationSource::new(&migrations);
        let manifest = load_migration_manifest(
            source.journal_path(),
            source.migrations_dir(),
            MigrationLimits::default(),
        )
        .unwrap();
        let backup_dir = tempfile::tempdir().expect("could not create recovery fixture directory");
        let backup_path = backup_dir.path().join("pre-migration.sql");
        let backup = TEST_RECOVERY_DUMP;
        fs::write(&backup_path, backup).unwrap();
        let digest = Sha256::digest(backup)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let receipt = MigrationRecoveryPointReceipt {
            path: backup_path,
            size_bytes: backup.len() as u64,
            sha256: digest,
            includes_migration_journal: true,
        };
        Self {
            _source_dir: source_dir,
            source,
            manifest,
            backup_dir,
            receipt,
        }
    }
}

async fn create_pending_database(pool: &PgPool) {
    sqlx::raw_sql(
        r#"
        CREATE TABLE public.organizations (id text PRIMARY KEY);
        CREATE TABLE public.org_child (org_id text REFERENCES public.organizations(id));
        INSERT INTO public.organizations (id) VALUES ('keep-me');
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (
          id serial PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        );
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn cancelled_backup_closes_the_locked_session_and_fresh_apply_succeeds() {
    let database = DisposableDatabase::create().await;
    let fixture = PendingMigrationFixture::new();
    create_pending_database(&database.pool).await;
    let service = MigrationApplyService::new(database.pool.clone());
    let callback_started = Arc::new(AtomicBool::new(false));
    let task_started = callback_started.clone();
    tokio::select! {
        result = service.apply_pending_migrations(
            &fixture.manifest,
            &fixture.source,
            move || async move {
                task_started.store(true, Ordering::Release);
                std::future::pending::<Result<MigrationRecoveryPointReceipt, String>>().await
            },
        ) => {
            panic!("apply completed instead of waiting in its recovery callback: {result:?}");
        }
        _ = tokio::time::timeout(Duration::from_secs(10), async {
            while !callback_started.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }) => {}
    }
    assert!(
        callback_started.load(Ordering::Acquire),
        "apply never reached the recovery callback while holding the advisory lock"
    );

    let mut probe = database.pool.acquire().await.unwrap();
    let acquired = sqlx::query_scalar::<_, bool>(
        "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1))",
    )
    .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
    .fetch_one(&mut *probe)
    .await
    .unwrap();
    assert!(
        acquired,
        "cancelled apply leaked the Node-compatible session lock"
    );
    sqlx::query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut *probe)
        .await
        .unwrap();
    drop(probe);

    let report = service
        .apply_pending_migrations(&fixture.manifest, &fixture.source, || {
            let receipt = fixture.receipt.clone();
            async move { Ok(receipt) }
        })
        .await
        .expect("fresh apply could not acquire the lock after cancellation");
    assert_eq!(report.applied_migrations, ["0000_test_apply.sql"]);
    let kept_row: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM public.organizations WHERE id = 'keep-me')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(kept_row);

    let fixture_backup_exists = fixture.receipt.path.exists();
    assert!(fixture_backup_exists);
    let _ = fixture.backup_dir;
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn the_current_node_advisory_lock_blocks_rust_apply() {
    let database = DisposableDatabase::create().await;
    let fixture = PendingMigrationFixture::new();
    create_pending_database(&database.pool).await;
    let mut node_connection = database.pool.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut *node_connection)
        .await
        .unwrap();

    let callback_started = Arc::new(AtomicBool::new(false));
    let task_started = callback_started.clone();
    let service = MigrationApplyService::new(database.pool.clone());
    let receipt = fixture.receipt.clone();
    let mut apply = Box::pin(service.apply_pending_migrations(
        &fixture.manifest,
        &fixture.source,
        move || async move {
            task_started.store(true, Ordering::Release);
            Ok(receipt)
        },
    ));
    tokio::select! {
        result = &mut apply => panic!("Rust apply unexpectedly completed while Node held its lock: {result:?}"),
        _ = tokio::time::sleep(Duration::from_millis(250)) => {}
    }
    assert!(
        !callback_started.load(Ordering::Acquire),
        "Rust apply entered backup while Node held its advisory lock"
    );
    sqlx::query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut *node_connection)
        .await
        .unwrap();
    drop(node_connection);
    let result = tokio::time::timeout(Duration::from_secs(30), apply)
        .await
        .expect("Rust apply did not continue after the Node lock was released")
        .expect("Rust apply failed after the Node lock was released");
    assert_eq!(result.applied_migrations, ["0000_test_apply.sql"]);

    let _ = fixture.backup_dir;
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn forbidden_transaction_statement_rolls_back_prior_statements_and_history() {
    let database = DisposableDatabase::create().await;
    let fixture = PendingMigrationFixture::with_sql(
        "CREATE TABLE public.rust_apply_atomic_probe (id integer PRIMARY KEY);\n--> statement-breakpoint\nCREATE INDEX CONCURRENTLY rust_apply_forbidden_idx ON public.org_child (org_id);",
    );
    create_pending_database(&database.pool).await;
    let service = MigrationApplyService::new(database.pool.clone());
    let receipt = fixture.receipt.clone();
    let result = service
        .apply_pending_migrations(
            &fixture.manifest,
            &fixture.source,
            || async move { Ok(receipt) },
        )
        .await;
    let probe_table_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public.rust_apply_atomic_probe') IS NOT NULL")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    database.cleanup().await;

    assert!(matches!(
        result,
        Err(MigrationApplyError::MigrationFailed { .. })
    ));
    assert!(
        !probe_table_exists,
        "failed migration leaked its first DDL statement"
    );
    assert_eq!(
        history_count, 0,
        "failed migration was written to the journal"
    );
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn shipped_source_bootstraps_reconciles_legacy_index_and_upgrades() {
    let database = DisposableDatabase::create().await;
    let shipped_migrations = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/db/src/migrations");
    let source = MigrationSource::new(&shipped_migrations);
    let manifest = load_migration_manifest(
        source.journal_path(),
        source.migrations_dir(),
        MigrationLimits::default(),
    )
    .unwrap();
    assert_eq!(manifest.journal.entries.len(), 179);
    assert_eq!(manifest.entries.len(), 181);
    assert_eq!(
        manifest
            .entries
            .iter()
            .filter(|entry| entry.is_legacy_unjournaled())
            .map(|entry| entry.file_name.as_str())
            .collect::<Vec<_>>(),
        [
            "0055_illegal_sheva_callister.sql",
            "0128_modern_jetstream.sql"
        ]
    );

    let service = MigrationApplyService::new(database.pool.clone());
    let bootstrap = service
        .apply_pending_migrations(&manifest, &source, || async {
            Err("empty bootstrap must not request a recovery point".to_owned())
        })
        .await
        .expect("current shipped source should bootstrap an empty disposable database");
    assert_eq!(bootstrap.applied_migrations.len(), 181);
    let initial_history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(initial_history_count, 181);

    let legacy_index = manifest
        .entries
        .iter()
        .find(|entry| entry.file_name == "0128_modern_jetstream.sql")
        .unwrap();
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1")
        .bind(&legacy_index.sha256)
        .execute(&database.pool)
        .await
        .unwrap();
    let recovery_dir = tempfile::tempdir().unwrap();
    let receipt = write_receipt(&recovery_dir, "legacy-reconcile.sql");
    let reconciled = service
        .apply_pending_migrations(&manifest, &source, || {
            let receipt = receipt.clone();
            async move { Ok(receipt) }
        })
        .await
        .expect("valid existing 0128 catalog index should be recorded without replay");
    assert_eq!(
        reconciled.reconciled_legacy_migrations,
        ["0128_modern_jetstream.sql"]
    );
    assert!(reconciled.applied_migrations.is_empty());

    let copied_root = tempfile::tempdir().unwrap();
    let copied_migrations = copied_root.path().join("migrations");
    fs::create_dir_all(copied_migrations.join("meta")).unwrap();
    for item in fs::read_dir(&shipped_migrations).unwrap() {
        let item = item.unwrap();
        let path = item.path();
        if path.extension().is_some_and(|extension| extension == "sql") {
            fs::copy(&path, copied_migrations.join(item.file_name())).unwrap();
        }
    }
    let journal_path = shipped_migrations.join("meta/_journal.json");
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    let mut journal = journal;
    journal["entries"].as_array_mut().unwrap().push(json!({
        "idx": 179,
        "version": "7",
        "when": 1_800_000_000_000_u64,
        "tag": "0179_rust_apply_upgrade_probe",
        "breakpoints": true
    }));
    fs::write(
        copied_migrations.join("meta/_journal.json"),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    fs::write(
        copied_migrations.join("0179_rust_apply_upgrade_probe.sql"),
        "CREATE TABLE public.rust_apply_upgrade_probe (id integer PRIMARY KEY);",
    )
    .unwrap();
    let upgraded_source = MigrationSource::new(&copied_migrations);
    let upgraded_manifest = load_migration_manifest(
        upgraded_source.journal_path(),
        upgraded_source.migrations_dir(),
        MigrationLimits::default(),
    )
    .unwrap();
    let upgrade = service
        .apply_pending_migrations(&upgraded_manifest, &upgraded_source, || {
            let receipt = receipt.clone();
            async move { Ok(receipt) }
        })
        .await
        .expect("actual shipped history prefix should accept the appended migration");
    assert_eq!(
        upgrade.applied_migrations,
        ["0179_rust_apply_upgrade_probe.sql"]
    );
    assert!(upgrade.recovery_point.is_some());
    let upgraded_history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(upgraded_history_count, 182);
    let retry = service
        .apply_pending_migrations(&upgraded_manifest, &upgraded_source, || async {
            Err("current database must not request another recovery point".to_owned())
        })
        .await
        .expect("applying the same shipped-source upgrade twice should be idempotent");
    assert!(retry.already_current);
    assert!(retry.applied_migrations.is_empty());

    database.cleanup().await;
}

fn write_receipt(directory: &TempDir, file_name: &str) -> MigrationRecoveryPointReceipt {
    let path = directory.path().join(file_name);
    let backup = TEST_RECOVERY_DUMP;
    fs::write(&path, backup).unwrap();
    let sha256 = Sha256::digest(backup)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    MigrationRecoveryPointReceipt {
        path,
        size_bytes: backup.len() as u64,
        sha256,
        includes_migration_journal: true,
    }
}
