use rudder_migration_core::{
    MigrationLimits, MigrationManifest, MigrationSource, load_migration_manifest,
};
use rudder_migration_service::{
    MigrationApplyError, MigrationApplyService, MigrationPreflightService,
    MigrationRecoveryPointReceipt, NODE_MIGRATION_ADVISORY_LOCK_NAME,
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
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

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

fn shipped_migration_source() -> (MigrationSource, MigrationManifest) {
    let migrations = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/db/src/migrations");
    let source = MigrationSource::new(&migrations);
    let manifest = load_migration_manifest(
        source.journal_path(),
        source.migrations_dir(),
        MigrationLimits::default(),
    )
    .expect("shipped migration source should load");
    (source, manifest)
}

async fn bootstrap_current_shipped_database(
    database: &DisposableDatabase,
) -> (MigrationSource, MigrationManifest) {
    let (source, manifest) = shipped_migration_source();
    let service = MigrationApplyService::new(database.pool.clone());
    let report = service
        .apply_pending_migrations(&manifest, &source, || async {
            Err("empty bootstrap must not request a recovery point".to_owned())
        })
        .await
        .expect("shipped migrations should bootstrap a disposable database");
    assert!(!report.already_current);
    assert_eq!(report.applied_migrations.len(), manifest.entries.len());
    (source, manifest)
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
    // Dropping the SQLx connection initiates socket close; PostgreSQL observes
    // EOF asynchronously. Require observable cleanup, not same-tick scheduling.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let acquired = sqlx::query_scalar::<_, bool>(
                "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1))",
            )
            .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
            .fetch_one(&mut *probe)
            .await
            .unwrap();
            if acquired {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cancelled apply leaked the Node-compatible session lock");
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
async fn cancelling_active_statement_rolls_back_and_allows_retry() {
    const MARKER: &str = "RUDDER_MIGRATION_CANCEL_TEST_MARKER";
    let database = DisposableDatabase::create().await;
    create_pending_database(&database.pool).await;
    sqlx::query("CREATE TABLE public.rust_apply_cancel_gate (allow_retry boolean NOT NULL)")
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO public.rust_apply_cancel_gate (allow_retry) VALUES (false)")
        .execute(&database.pool)
        .await
        .unwrap();

    let fixture = PendingMigrationFixture::with_sql(&format!(
        "CREATE TABLE public.rust_apply_active_cancel (id integer PRIMARY KEY);\n--> statement-breakpoint\nDO /* {MARKER} */ $cancel$ BEGIN IF NOT EXISTS (SELECT 1 FROM public.rust_apply_cancel_gate WHERE allow_retry) THEN PERFORM pg_sleep(300); END IF; INSERT INTO public.rust_apply_active_cancel(id) VALUES (1); END $cancel$;"
    ));
    let service = MigrationApplyService::new(database.pool.clone());
    let cancellation = CancellationToken::new();
    let task_cancellation = cancellation.clone();
    let manifest = fixture.manifest.clone();
    let source = fixture.source.clone();
    let receipt = fixture.receipt.clone();
    let control_pool = database.pool.clone();
    let apply = service.apply_pending_migrations_cancellable(
        &manifest,
        &source,
        task_cancellation,
        &control_pool,
        move || async move { Ok(receipt) },
    );
    tokio::pin!(apply);

    let (backend_pid, backend_start): (i32, String) = tokio::time::timeout(
        Duration::from_secs(10),
        async {
            loop {
                tokio::select! {
                    result = apply.as_mut() => panic!("migration ended before the active statement was observed: {result:?}"),
                    row = sqlx::query(
                        "SELECT pid, backend_start::text AS backend_start FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND query LIKE $1",
                    )
                    .bind(format!("%{MARKER}%"))
                    .fetch_optional(&database.pool) => {
                        let row = row.unwrap();
                        if let Some(row) = row {
                            break (row.try_get("pid").unwrap(), row.try_get("backend_start").unwrap());
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        },
    )
    .await
    .expect("migration never reached the deliberately active PostgreSQL statement");

    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(30), apply.as_mut())
        .await
        .expect("active migration cancellation did not finish cleanup");
    assert!(matches!(
        result,
        Err(MigrationApplyError::OperationCancelled)
    ));

    let owned_backend_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz)",
    )
    .bind(backend_pid)
    .bind(&backend_start)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let probe_table_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public.rust_apply_active_cancel') IS NOT NULL")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert!(
        !owned_backend_exists,
        "cancelled PostgreSQL backend remained connected"
    );
    assert!(
        !probe_table_exists,
        "cancelled migration leaked its transactional DDL"
    );
    assert_eq!(history_count, 0, "cancelled migration changed the journal");

    let mut lock_probe = database.pool.acquire().await.unwrap();
    let lock_acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1))",
    )
    .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
    .fetch_one(&mut *lock_probe)
    .await
    .unwrap();
    assert!(
        lock_acquired,
        "cancelled migration retained the advisory lock"
    );
    sqlx::query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut *lock_probe)
        .await
        .unwrap();
    drop(lock_probe);

    sqlx::query("UPDATE public.rust_apply_cancel_gate SET allow_retry = true")
        .execute(&database.pool)
        .await
        .unwrap();
    let retry = MigrationApplyService::new(database.pool.clone())
        .apply_pending_migrations(&fixture.manifest, &fixture.source, || {
            let receipt = fixture.receipt.clone();
            async move { Ok(receipt) }
        })
        .await
        .expect("fresh migration retry failed after active-statement cancellation");
    assert_eq!(retry.applied_migrations, ["0000_test_apply.sql"]);
    let retried_row_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM public.rust_apply_active_cancel WHERE id = 1)",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let retried_history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert!(
        retried_row_exists,
        "retry did not finish the cancelled migration"
    );
    assert_eq!(
        retried_history_count, 1,
        "retry did not append exactly one journal row"
    );

    let _ = fixture.backup_dir;
    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn cancellation_at_recovery_point_barrier_prevents_migration_side_effects() {
    let database = DisposableDatabase::create().await;
    create_pending_database(&database.pool).await;
    let fixture = PendingMigrationFixture::new();
    let service = MigrationApplyService::new(database.pool.clone());
    let cancellation = CancellationToken::new();
    let (backup_started_tx, backup_started_rx) = oneshot::channel();
    let (continue_backup_tx, continue_backup_rx) = oneshot::channel();
    let control_pool = database.pool.clone();
    let receipt = fixture.receipt.clone();
    let apply = service.apply_pending_migrations_cancellable(
        &fixture.manifest,
        &fixture.source,
        cancellation.clone(),
        &control_pool,
        move || async move {
            let _ = backup_started_tx.send(());
            let _ = continue_backup_rx.await;
            Ok(receipt)
        },
    );
    tokio::pin!(apply);

    tokio::select! {
        result = apply.as_mut() => {
            panic!("migration finished before reaching the recovery-point barrier: {result:?}");
        }
        announced = tokio::time::timeout(Duration::from_secs(10), backup_started_rx) => {
            announced
                .expect("migration did not reach the recovery-point barrier")
                .expect("recovery-point callback ended before announcing its barrier");
        }
    }
    cancellation.cancel();
    let _ = continue_backup_tx.send(());
    let result = tokio::time::timeout(Duration::from_secs(30), apply.as_mut())
        .await
        .expect("cancellation at the recovery-point barrier did not finish cleanup");
    assert!(matches!(
        result,
        Err(MigrationApplyError::OperationCancelled)
    ));

    let migration_table_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public.rust_apply_test') IS NOT NULL")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert!(
        !migration_table_exists,
        "cancellation after backup started a migration transaction"
    );
    assert_eq!(
        history_count, 0,
        "cancellation changed the migration journal"
    );

    let mut lock_probe = database.pool.acquire().await.unwrap();
    let lock_acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1))",
    )
    .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
    .fetch_one(&mut *lock_probe)
    .await
    .unwrap();
    assert!(
        lock_acquired,
        "cancelled migration retained the advisory lock"
    );
    sqlx::query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut *lock_probe)
        .await
        .unwrap();
    drop(lock_probe);

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
async fn current_database_repairs_all_seven_legacy_column_aliases() {
    let database = DisposableDatabase::create().await;
    let (source, manifest) = bootstrap_current_shipped_database(&database).await;
    let fixture = PendingMigrationFixture::new();
    let service = MigrationApplyService::new(database.pool.clone());

    sqlx::raw_sql(
        r#"
        INSERT INTO public.organizations (id, url_key, name)
        VALUES ('00000000-0000-4000-8000-000000000001', 'legacy-alias-test', 'Legacy alias test');
        INSERT INTO public.agents (id, org_id, name, agent_runtime_type, agent_runtime_config)
        VALUES (
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000001',
          'Legacy alias agent',
          'codex-local',
          '{"provider":{"name":"codex","options":{"workspace":"/data/work","scopes":["read","write"]}},"flags":[true,{"retry":3}]}'::jsonb
        );
        INSERT INTO public.agent_runtime_state (agent_id, org_id, agent_runtime_type, state_json)
        VALUES (
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000001',
          'hermes-gateway',
          '{"conversation":{"id":"conv-42","cursor":{"page":7,"token":"state-token"}}}'::jsonb
        );
        INSERT INTO public.agent_task_sessions (id, org_id, agent_id, agent_runtime_type, task_key)
        VALUES (
          '00000000-0000-4000-8000-000000000003',
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          'cursor-local',
          'task-key-preserved'
        );
        INSERT INTO public.invites (id, org_id, token_hash, expires_at)
        VALUES (
          '00000000-0000-4000-8000-000000000004',
          '00000000-0000-4000-8000-000000000001',
          'legacy-alias-invite-hash',
          '2099-01-01T00:00:00Z'
        );
        INSERT INTO public.join_requests (id, invite_id, org_id, request_type, request_ip, agent_runtime_type)
        VALUES (
          '00000000-0000-4000-8000-000000000005',
          '00000000-0000-4000-8000-000000000004',
          '00000000-0000-4000-8000-000000000001',
          'agent',
          '127.0.0.1',
          'openclaw-gateway'
        );
        INSERT INTO public.finance_events (
          id, org_id, event_kind, biller, amount_cents, occurred_at, execution_agent_runtime_type
        ) VALUES (
          '00000000-0000-4000-8000-000000000006',
          '00000000-0000-4000-8000-000000000001',
          'execution',
          'synthetic-test',
          1234,
          '2026-10-16T00:00:00Z',
          'opencode-local'
        );
        INSERT INTO public.issues (id, org_id, title, assignee_agent_runtime_overrides)
        VALUES (
          '00000000-0000-4000-8000-000000000007',
          '00000000-0000-4000-8000-000000000001',
          'Preserve nested legacy overrides',
          '{"runtime":{"provider":"pi-local","config":{"model":"test-model","limits":{"tokens":8192}}},"fallbacks":["process",{"runtime":"claude-local"}]}'::jsonb
        );
        "#,
    )
    .execute(&database.pool)
    .await
    .expect("representative rows should be present before legacy column renames");

    sqlx::raw_sql(
        r#"
        ALTER TABLE public.agents RENAME COLUMN agent_runtime_type TO adapter_type;
        ALTER TABLE public.agents RENAME COLUMN agent_runtime_config TO adapter_config;
        ALTER TABLE public.agent_runtime_state RENAME COLUMN agent_runtime_type TO adapter_type;
        ALTER TABLE public.agent_task_sessions RENAME COLUMN agent_runtime_type TO adapter_type;
        ALTER TABLE public.join_requests RENAME COLUMN agent_runtime_type TO adapter_type;
        ALTER TABLE public.finance_events RENAME COLUMN execution_agent_runtime_type TO execution_adapter_type;
        ALTER TABLE public.issues RENAME COLUMN assignee_agent_runtime_overrides TO assignee_adapter_overrides;
        "#,
    )
    .execute(&database.pool)
    .await
    .expect("legacy aliases should be installed in the disposable database");

    let preflight = MigrationPreflightService::new(database.pool.clone())
        .preflight(&manifest)
        .await
        .expect("preflight should include the fixed alias inventory");
    assert_eq!(
        preflight.status,
        rudder_migration_service::MigrationPreflightStatus::Current
    );
    assert_eq!(
        preflight.pending_legacy_column_renames,
        [
            "agents.adapter_type->agent_runtime_type",
            "agents.adapter_config->agent_runtime_config",
            "agent_runtime_state.adapter_type->agent_runtime_type",
            "agent_task_sessions.adapter_type->agent_runtime_type",
            "join_requests.adapter_type->agent_runtime_type",
            "finance_events.execution_adapter_type->execution_agent_runtime_type",
            "issues.assignee_adapter_overrides->assignee_agent_runtime_overrides",
        ]
    );
    assert!(preflight.legacy_column_conflicts.is_empty());

    let receipt = fixture.receipt.clone();
    let report = service
        .apply_pending_migrations(&manifest, &source, || async move { Ok(receipt) })
        .await
        .expect("current journal should repair all known column aliases");
    assert!(report.already_current);
    assert_eq!(
        report.normalized_legacy_columns,
        [
            "agents.adapter_type->agent_runtime_type",
            "agents.adapter_config->agent_runtime_config",
            "agent_runtime_state.adapter_type->agent_runtime_type",
            "agent_task_sessions.adapter_type->agent_runtime_type",
            "join_requests.adapter_type->agent_runtime_type",
            "finance_events.execution_adapter_type->execution_agent_runtime_type",
            "issues.assignee_adapter_overrides->assignee_agent_runtime_overrides",
        ]
    );
    assert!(report.recovery_point.is_some());

    let canonical_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND \
         ((table_name='agents' AND column_name IN ('agent_runtime_type', 'agent_runtime_config')) OR \
          (table_name='agent_runtime_state' AND column_name='agent_runtime_type') OR \
          (table_name='agent_task_sessions' AND column_name='agent_runtime_type') OR \
          (table_name='join_requests' AND column_name='agent_runtime_type') OR \
          (table_name='finance_events' AND column_name='execution_agent_runtime_type') OR \
          (table_name='issues' AND column_name='assignee_agent_runtime_overrides'))",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let legacy_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND \
         ((table_name='agents' AND column_name IN ('adapter_type', 'adapter_config')) OR \
          (table_name='agent_runtime_state' AND column_name='adapter_type') OR \
          (table_name='agent_task_sessions' AND column_name='adapter_type') OR \
          (table_name='join_requests' AND column_name='adapter_type') OR \
          (table_name='finance_events' AND column_name='execution_adapter_type') OR \
          (table_name='issues' AND column_name='assignee_adapter_overrides'))",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(canonical_count, 7);
    assert_eq!(legacy_count, 0);

    let agent = sqlx::query(
        "SELECT agent_runtime_type, agent_runtime_config FROM public.agents \
         WHERE id = '00000000-0000-4000-8000-000000000002'::uuid",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        agent.try_get::<String, _>("agent_runtime_type").unwrap(),
        "codex-local"
    );
    assert_eq!(
        agent
            .try_get::<serde_json::Value, _>("agent_runtime_config")
            .unwrap(),
        json!({
            "provider": {"name": "codex", "options": {"workspace": "/data/work", "scopes": ["read", "write"]}},
            "flags": [true, {"retry": 3}]
        })
    );

    let runtime_state_type: String = sqlx::query_scalar(
        "SELECT agent_runtime_type FROM public.agent_runtime_state \
         WHERE agent_id = '00000000-0000-4000-8000-000000000002'::uuid",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(runtime_state_type, "hermes-gateway");

    let task_session_type: String = sqlx::query_scalar(
        "SELECT agent_runtime_type FROM public.agent_task_sessions \
         WHERE id = '00000000-0000-4000-8000-000000000003'::uuid",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(task_session_type, "cursor-local");

    let join_request_type: String = sqlx::query_scalar(
        "SELECT agent_runtime_type FROM public.join_requests \
         WHERE id = '00000000-0000-4000-8000-000000000005'::uuid",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(join_request_type, "openclaw-gateway");

    let finance_event_type: String = sqlx::query_scalar(
        "SELECT execution_agent_runtime_type FROM public.finance_events \
         WHERE id = '00000000-0000-4000-8000-000000000006'::uuid",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(finance_event_type, "opencode-local");

    let issue_overrides: serde_json::Value = sqlx::query_scalar(
        "SELECT assignee_agent_runtime_overrides FROM public.issues \
         WHERE id = '00000000-0000-4000-8000-000000000007'::uuid",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        issue_overrides,
        json!({
            "runtime": {"provider": "pi-local", "config": {"model": "test-model", "limits": {"tokens": 8192}}},
            "fallbacks": ["process", {"runtime": "claude-local"}]
        })
    );

    let retry = service
        .apply_pending_migrations(&manifest, &source, || async {
            Err("fully current database must not request another recovery point".to_owned())
        })
        .await
        .expect("normalized current journal should be idempotent");
    assert!(retry.already_current);
    assert!(retry.normalized_legacy_columns.is_empty());
    assert!(retry.recovery_point.is_none());

    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn current_journal_alias_repair_requires_a_validated_recovery_point() {
    let database = DisposableDatabase::create().await;
    let (source, manifest) = bootstrap_current_shipped_database(&database).await;
    let service = MigrationApplyService::new(database.pool.clone());
    sqlx::query("ALTER TABLE public.agents RENAME COLUMN agent_runtime_type TO adapter_type")
        .execute(&database.pool)
        .await
        .unwrap();

    let invoked = Arc::new(AtomicBool::new(false));
    let callback_invoked = invoked.clone();
    let result = service
        .apply_pending_migrations(&manifest, &source, move || async move {
            callback_invoked.store(true, Ordering::Release);
            Err("backup is unavailable".to_owned())
        })
        .await;
    assert!(matches!(
        result,
        Err(MigrationApplyError::RecoveryPointProvider(message)) if message == "backup is unavailable"
    ));
    assert!(invoked.load(Ordering::Acquire));
    let old_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
         WHERE table_schema='public' AND table_name='agents' AND column_name='adapter_type')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let target_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
         WHERE table_schema='public' AND table_name='agents' AND column_name='agent_runtime_type')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(
        old_exists,
        "failed backup must leave the old alias untouched"
    );
    assert!(
        !target_exists,
        "failed backup must not create the target column"
    );

    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn alias_collision_is_rejected_without_overwriting_either_column() {
    let database = DisposableDatabase::create().await;
    let (source, manifest) = bootstrap_current_shipped_database(&database).await;
    let service = MigrationApplyService::new(database.pool.clone());
    sqlx::query("ALTER TABLE public.agents ADD COLUMN adapter_type text")
        .execute(&database.pool)
        .await
        .unwrap();
    let preflight = MigrationPreflightService::new(database.pool.clone())
        .preflight(&manifest)
        .await
        .expect("preflight should expose alias conflicts");
    assert!(preflight.pending_legacy_column_renames.is_empty());
    assert_eq!(
        preflight.legacy_column_conflicts,
        ["agents.adapter_type+agent_runtime_type"]
    );

    let result = service
        .apply_pending_migrations(&manifest, &source, || async {
            Err("collision must fail before requesting backup".to_owned())
        })
        .await;
    assert!(matches!(
        result,
        Err(MigrationApplyError::LegacyColumnCollision(message))
            if message.contains("agents.adapter_type+agent_runtime_type")
    ));
    let columns_present: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' \
         AND table_name='agents' AND column_name IN ('agent_runtime_type', 'adapter_type')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        columns_present, 2,
        "both conflicting columns must remain intact"
    );

    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn alias_repair_waits_for_the_node_lock_then_retries_safely() {
    let database = DisposableDatabase::create().await;
    let (source, manifest) = bootstrap_current_shipped_database(&database).await;
    let fixture = PendingMigrationFixture::new();
    let service = MigrationApplyService::new(database.pool.clone());
    sqlx::query("ALTER TABLE public.agents RENAME COLUMN agent_runtime_type TO adapter_type")
        .execute(&database.pool)
        .await
        .unwrap();

    let mut node_connection = database.pool.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut *node_connection)
        .await
        .unwrap();

    let callback_started = Arc::new(AtomicBool::new(false));
    let task_callback_started = callback_started.clone();
    let receipt = fixture.receipt.clone();
    let mut apply =
        Box::pin(
            service.apply_pending_migrations(&manifest, &source, move || async move {
                task_callback_started.store(true, Ordering::Release);
                Ok(receipt)
            }),
        );
    tokio::select! {
        result = &mut apply => panic!("Rust apply unexpectedly completed while Node held its lock: {result:?}"),
        _ = tokio::time::sleep(Duration::from_millis(200)) => {}
    }
    assert!(
        !callback_started.load(Ordering::Acquire),
        "backup must not begin before the shared advisory lock is acquired"
    );
    let old_still_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
         WHERE table_schema='public' AND table_name='agents' AND column_name='adapter_type')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(
        old_still_exists,
        "locked retry must not mutate aliases early"
    );

    sqlx::query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1))")
        .bind(NODE_MIGRATION_ADVISORY_LOCK_NAME)
        .execute(&mut *node_connection)
        .await
        .unwrap();
    drop(node_connection);
    let report = tokio::time::timeout(Duration::from_secs(30), apply)
        .await
        .expect("Rust apply did not continue after the Node lock was released")
        .expect("alias retry failed after the Node lock was released");
    assert!(callback_started.load(Ordering::Acquire));
    assert_eq!(
        report.normalized_legacy_columns,
        ["agents.adapter_type->agent_runtime_type"]
    );

    database.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable local PostgreSQL cluster"]
async fn catalog_history_repair_is_source_pinned_and_0103_replay_fails_closed_on_existing_ddl() {
    let database = DisposableDatabase::create().await;
    let (source, manifest) = bootstrap_current_shipped_database(&database).await;
    let service = MigrationApplyService::new(database.pool.clone());
    let recovery_dir = tempfile::tempdir().unwrap();
    let receipt = write_receipt(&recovery_dir, "catalog-history-repair.sql");
    let entry_hash = |name: &str| {
        manifest
            .entries
            .iter()
            .find(|entry| entry.file_name == name)
            .unwrap()
            .sha256
            .clone()
    };
    let apply = || {
        let receipt = receipt.clone();
        service.apply_pending_migrations(&manifest, &source, move || async move { Ok(receipt) })
    };
    let history_rows = |hash: String| async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash = $1",
        )
        .bind(hash)
        .fetch_one(&database.pool)
        .await
        .unwrap()
    };
    let history_rows_by_name = |name: String| async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE name = $1",
        )
        .bind(name)
        .fetch_one(&database.pool)
        .await
        .unwrap()
    };
    macro_rules! assert_0031_repair_rejected {
        ($hash:expr) => {{
            let result = apply().await;
            assert!(matches!(
                &result,
                Err(MigrationApplyError::CatalogHistoryRepairRejected {
                    file_name,
                    ..
                }) if file_name == "0031_zippy_magma.sql"
            ), "0031 catalog repair should fail closed: {result:?}");
            assert_eq!(history_rows(($hash).clone()).await, 0);
        }};
    }

    // Both exact non-idempotent SQL files have already produced their full
    // shipped catalog effects. Repair only their rows; never replay the SQL.
    for migration in ["0021_chief_vindicator.sql", "0031_zippy_magma.sql"] {
        sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1")
            .bind(entry_hash(migration))
            .execute(&database.pool)
            .await
            .unwrap();
    }
    let repaired = apply()
        .await
        .expect("complete pinned catalog should repair history");
    assert!(repaired.applied_migrations.is_empty());
    assert_eq!(
        history_rows(entry_hash("0021_chief_vindicator.sql")).await,
        1
    );
    assert_eq!(history_rows(entry_hash("0031_zippy_magma.sql")).await, 1);

    // A supported alias is normalized only inside the repair transaction. If
    // the renamed column has the wrong type, both the rename and history
    // repair roll back while preserving the user's pre-call schema.
    let hash_0021 = entry_hash("0021_chief_vindicator.sql");
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1")
        .bind(&hash_0021)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::raw_sql(
        "ALTER TABLE public.issues RENAME COLUMN assignee_agent_runtime_overrides TO assignee_adapter_overrides; \
         ALTER TABLE public.issues ALTER COLUMN assignee_adapter_overrides TYPE text USING assignee_adapter_overrides::text;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    let rejected = apply().await;
    assert!(
        matches!(
            &rejected,
            Err(MigrationApplyError::CatalogHistoryRepairRejected {
                file_name,
                ..
            }) if file_name == "0021_chief_vindicator.sql"
        ),
        "wrong-type catalog repair should fail closed: {rejected:?}"
    );
    let alias_state = sqlx::query(
        "SELECT column_name, udt_name FROM information_schema.columns \
         WHERE table_schema='public' AND table_name='issues' \
           AND column_name IN ('assignee_agent_runtime_overrides','assignee_adapter_overrides')",
    )
    .fetch_all(&database.pool)
    .await
    .unwrap();
    assert_eq!(alias_state.len(), 1);
    assert_eq!(
        alias_state[0].try_get::<String, _>("column_name").unwrap(),
        "assignee_adapter_overrides"
    );
    assert_eq!(
        alias_state[0].try_get::<String, _>("udt_name").unwrap(),
        "text"
    );
    assert_eq!(history_rows(hash_0021.clone()).await, 0);
    sqlx::raw_sql(
        "ALTER TABLE public.issues ALTER COLUMN assignee_adapter_overrides TYPE jsonb USING assignee_adapter_overrides::jsonb;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    apply()
        .await
        .expect("exact supported alias should normalize with catalog repair");
    assert_eq!(history_rows(hash_0021).await, 1);

    // A missing required 0031 index makes the historical repair partial. No
    // history row is inserted and the missing index is not silently rebuilt.
    let hash_0031 = entry_hash("0031_zippy_magma.sql");
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1")
        .bind(&hash_0031)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("DROP INDEX public.finance_events_company_cost_event_idx")
        .execute(&database.pool)
        .await
        .unwrap();
    let missing_index_repair = apply().await;
    assert!(
        matches!(
            &missing_index_repair,
            Err(MigrationApplyError::CatalogHistoryRepairRejected {
                file_name,
                ..
            }) if file_name == "0031_zippy_magma.sql"
        ),
        "missing 0031 index should fail closed: {missing_index_repair:?}"
    );
    assert_eq!(history_rows(hash_0031.clone()).await, 0);
    let index_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'finance_events_company_cost_event_idx')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(!index_exists);
    sqlx::query(
        "CREATE INDEX finance_events_company_cost_event_idx \
         ON public.finance_events USING btree (org_id, cost_event_id)",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    apply()
        .await
        .expect("restored exact 0031 index should permit repair");
    assert_eq!(history_rows(hash_0031).await, 1);

    // Exercise adversarial same-name catalog definitions. The missing row is
    // left absent across each rejected attempt, so each proof sees the same
    // single repair candidate.
    let hash_0031 = entry_hash("0031_zippy_magma.sql");
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1")
        .bind(&hash_0031)
        .execute(&database.pool)
        .await
        .unwrap();

    // A composite FK preserving the expected first source/target columns is
    // not equivalent to the single-column FK from the pinned migration.
    sqlx::raw_sql(
        "ALTER TABLE public.agents ADD COLUMN catalog_repair_probe uuid; \
         ALTER TABLE public.agents ADD CONSTRAINT agents_catalog_repair_probe_uq UNIQUE (id, catalog_repair_probe); \
         ALTER TABLE public.finance_events ADD COLUMN catalog_repair_probe uuid; \
         ALTER TABLE public.finance_events DROP CONSTRAINT finance_events_agent_id_agents_id_fk; \
         ALTER TABLE public.finance_events ADD CONSTRAINT finance_events_agent_id_agents_id_fk \
           FOREIGN KEY (agent_id, catalog_repair_probe) REFERENCES public.agents (id, catalog_repair_probe);",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_0031_repair_rejected!(hash_0031);
    sqlx::raw_sql(
        "ALTER TABLE public.finance_events DROP CONSTRAINT finance_events_agent_id_agents_id_fk; \
         ALTER TABLE public.finance_events ADD CONSTRAINT finance_events_agent_id_agents_id_fk \
           FOREIGN KEY (agent_id) REFERENCES public.agents (id); \
         ALTER TABLE public.finance_events DROP COLUMN catalog_repair_probe; \
         ALTER TABLE public.agents DROP CONSTRAINT agents_catalog_repair_probe_uq; \
         ALTER TABLE public.agents DROP COLUMN catalog_repair_probe;",
    )
    .execute(&database.pool)
    .await
    .unwrap();

    // MATCH FULL changes the null semantics and must not satisfy the pinned
    // default MATCH SIMPLE foreign key.
    sqlx::raw_sql(
        "ALTER TABLE public.finance_events DROP CONSTRAINT finance_events_agent_id_agents_id_fk; \
         ALTER TABLE public.finance_events ADD CONSTRAINT finance_events_agent_id_agents_id_fk \
           FOREIGN KEY (agent_id) REFERENCES public.agents (id) MATCH FULL;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_0031_repair_rejected!(hash_0031);
    sqlx::raw_sql(
        "ALTER TABLE public.finance_events DROP CONSTRAINT finance_events_agent_id_agents_id_fk; \
         ALTER TABLE public.finance_events ADD CONSTRAINT finance_events_agent_id_agents_id_fk \
           FOREIGN KEY (agent_id) REFERENCES public.agents (id);",
    )
    .execute(&database.pool)
    .await
    .unwrap();

    // Descending order and non-default text opclasses are both distinct from
    // the ordinary ascending/default btree indexes in 0031.
    sqlx::raw_sql(
        "DROP INDEX public.finance_events_company_occurred_idx; \
         CREATE INDEX finance_events_company_occurred_idx ON public.finance_events USING btree (org_id DESC, occurred_at);",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_0031_repair_rejected!(hash_0031);
    sqlx::raw_sql(
        "DROP INDEX public.finance_events_company_occurred_idx; \
         CREATE INDEX finance_events_company_occurred_idx ON public.finance_events USING btree (org_id, occurred_at);",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        "DROP INDEX public.finance_events_company_biller_occurred_idx; \
         CREATE INDEX finance_events_company_biller_occurred_idx \
           ON public.finance_events USING btree (org_id, biller text_pattern_ops, occurred_at);",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_0031_repair_rejected!(hash_0031);
    sqlx::raw_sql(
        "DROP INDEX public.finance_events_company_biller_occurred_idx; \
         CREATE INDEX finance_events_company_biller_occurred_idx \
           ON public.finance_events USING btree (org_id, biller, occurred_at);",
    )
    .execute(&database.pool)
    .await
    .unwrap();

    // Same-named public domains over the expected PostgreSQL built-in types
    // must not pass merely because their base values are compatible.
    sqlx::raw_sql(
        "CREATE DOMAIN public.text AS pg_catalog.text; \
         ALTER TABLE public.cost_events ALTER COLUMN provider TYPE public.text \
           USING provider::pg_catalog.text::public.text;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_0031_repair_rejected!(hash_0031);
    sqlx::raw_sql(
        "ALTER TABLE public.cost_events ALTER COLUMN provider TYPE pg_catalog.text \
           USING provider::pg_catalog.text; \
         DROP DOMAIN public.text;",
    )
    .execute(&database.pool)
    .await
    .unwrap();

    sqlx::raw_sql(
        "CREATE DOMAIN public.timestamptz AS pg_catalog.timestamptz; \
         ALTER TABLE public.cost_events ALTER COLUMN occurred_at TYPE public.timestamptz \
           USING occurred_at::pg_catalog.timestamptz::public.timestamptz;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_0031_repair_rejected!(hash_0031);
    sqlx::raw_sql(
        "ALTER TABLE public.cost_events ALTER COLUMN occurred_at TYPE pg_catalog.timestamptz \
           USING occurred_at::pg_catalog.timestamptz; \
         DROP DOMAIN public.timestamptz;",
    )
    .execute(&database.pool)
    .await
    .unwrap();

    sqlx::raw_sql(
        "CREATE DOMAIN public.uuid AS pg_catalog.uuid; \
         ALTER TABLE public.cost_events DROP CONSTRAINT cost_events_company_id_companies_id_fk; \
         ALTER TABLE public.cost_events ALTER COLUMN org_id TYPE public.uuid \
           USING org_id::pg_catalog.uuid::public.uuid;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_0031_repair_rejected!(hash_0031);
    sqlx::raw_sql(
        "ALTER TABLE public.cost_events ALTER COLUMN org_id TYPE pg_catalog.uuid \
           USING org_id::pg_catalog.uuid; \
         ALTER TABLE public.cost_events ADD CONSTRAINT cost_events_company_id_companies_id_fk \
           FOREIGN KEY (org_id) REFERENCES public.organizations (id) ON DELETE NO ACTION ON UPDATE NO ACTION; \
         DROP DOMAIN public.uuid;",
    )
    .execute(&database.pool)
    .await
    .unwrap();

    // The legacy company_id/companies catalog pair remains supported, while
    // later harmless columns do not invalidate the exact pinned proof.
    sqlx::raw_sql(
        "CREATE TABLE public.companies (id uuid PRIMARY KEY); \
         INSERT INTO public.companies (id) SELECT id FROM public.organizations; \
         ALTER TABLE public.finance_events RENAME COLUMN org_id TO company_id; \
         ALTER TABLE public.cost_events RENAME COLUMN org_id TO company_id; \
         ALTER TABLE public.finance_events DROP CONSTRAINT finance_events_company_id_companies_id_fk; \
         ALTER TABLE public.cost_events DROP CONSTRAINT cost_events_company_id_companies_id_fk; \
         ALTER TABLE public.finance_events ADD CONSTRAINT finance_events_company_id_companies_id_fk \
           FOREIGN KEY (company_id) REFERENCES public.companies (id) ON DELETE NO ACTION ON UPDATE NO ACTION; \
         ALTER TABLE public.cost_events ADD CONSTRAINT cost_events_company_id_companies_id_fk \
           FOREIGN KEY (company_id) REFERENCES public.companies (id) ON DELETE NO ACTION ON UPDATE NO ACTION; \
         ALTER TABLE public.finance_events ADD COLUMN catalog_repair_extra text; \
         ALTER TABLE public.cost_events ADD COLUMN catalog_repair_extra text;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    let legacy_shape_repaired = apply()
        .await
        .expect("exact legacy company_id catalog shape should permit repair");
    assert!(legacy_shape_repaired.applied_migrations.is_empty());
    assert_eq!(history_rows(hash_0031).await, 1);

    // 0103 remains a pinned replay, not a catalog-repair exception. With its
    // complete DDL already present replay fails transactionally; a partial
    // shape also stays unchanged. Only when the effects are absent does the
    // existing SQL replay path apply and record it.
    let hash_0103 = entry_hash("0103_cute_colonel_america.sql");
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1")
        .bind(&hash_0103)
        .execute(&database.pool)
        .await
        .unwrap();
    let full_replay = apply().await;
    assert!(
        matches!(
            &full_replay,
            Err(MigrationApplyError::MigrationFailed {
                file_name,
                ..
            }) if file_name == "0103_cute_colonel_america.sql"
        ),
        "full 0103 replay should fail transactionally: {full_replay:?}"
    );
    assert_eq!(history_rows(hash_0103.clone()).await, 0);
    let full_columns: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' \
         AND table_name='heartbeat_runs' AND column_name IN \
           ('session_params_before_json','session_params_after_json','session_reuse_scope')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(full_columns, 3);

    sqlx::query("ALTER TABLE public.heartbeat_runs DROP COLUMN session_params_after_json")
        .execute(&database.pool)
        .await
        .unwrap();
    let partial_replay = apply().await;
    assert!(
        matches!(
            &partial_replay,
            Err(MigrationApplyError::MigrationFailed {
                file_name,
                ..
            }) if file_name == "0103_cute_colonel_america.sql"
        ),
        "partial 0103 replay should fail transactionally: {partial_replay:?}"
    );
    assert_eq!(history_rows(hash_0103.clone()).await, 0);
    let partial_columns: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' \
         AND table_name='heartbeat_runs' AND column_name IN \
           ('session_params_before_json','session_params_after_json','session_reuse_scope')",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(partial_columns, 2);

    sqlx::raw_sql(
        "ALTER TABLE public.heartbeat_runs DROP CONSTRAINT heartbeat_runs_session_reuse_scope_check; \
         ALTER TABLE public.heartbeat_runs DROP COLUMN session_params_before_json; \
         ALTER TABLE public.heartbeat_runs DROP COLUMN session_reuse_scope;",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    let absent_replay = apply()
        .await
        .expect("absent 0103 DDL should be applied by its existing exact pinned SQL");
    assert_eq!(
        absent_replay.applied_migrations,
        ["0103_cute_colonel_america.sql"]
    );
    assert_eq!(history_rows(hash_0103).await, 1);

    // Older Drizzle installations can have a name-only journal. Resolve its
    // rows by exact filenames, not by accepting a missing hash as a weaker
    // identity. Repair 0021 and 0031 only after the same pinned catalog proofs
    // used for hash-bearing journals succeed.
    sqlx::query("ALTER TABLE drizzle.__drizzle_migrations ADD COLUMN name text")
        .execute(&database.pool)
        .await
        .unwrap();
    for entry in &manifest.entries {
        sqlx::query("UPDATE drizzle.__drizzle_migrations SET name = $1 WHERE hash = $2")
            .bind(&entry.file_name)
            .bind(&entry.sha256)
            .execute(&database.pool)
            .await
            .unwrap();
    }
    let unnamed_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations WHERE name IS NULL")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(unnamed_rows, 0);
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE name IN ($1, $2)")
        .bind("0021_chief_vindicator.sql")
        .bind("0031_zippy_magma.sql")
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE drizzle.__drizzle_migrations DROP COLUMN hash")
        .execute(&database.pool)
        .await
        .unwrap();

    let name_only_repair = apply()
        .await
        .expect("exact name-only history and pinned catalog should repair both rows");
    assert!(name_only_repair.applied_migrations.is_empty());
    for migration in ["0021_chief_vindicator.sql", "0031_zippy_magma.sql"] {
        assert_eq!(history_rows_by_name(migration.to_owned()).await, 1);
    }

    // Repeated repair waves append a fresh row without making the other
    // previously appended repair row block the next name-only reconciliation.
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE name = $1")
        .bind("0021_chief_vindicator.sql")
        .execute(&database.pool)
        .await
        .unwrap();
    apply()
        .await
        .expect("name-only 0021 repair should remain valid after a prior repair wave");
    assert_eq!(
        history_rows_by_name("0021_chief_vindicator.sql".to_owned()).await,
        1
    );
    assert_eq!(
        history_rows_by_name("0031_zippy_magma.sql".to_owned()).await,
        1
    );
    sqlx::query("DELETE FROM drizzle.__drizzle_migrations WHERE name = $1")
        .bind("0031_zippy_magma.sql")
        .execute(&database.pool)
        .await
        .unwrap();
    apply()
        .await
        .expect("name-only 0031 repair should remain valid after repeated repair waves");
    assert_eq!(
        history_rows_by_name("0021_chief_vindicator.sql".to_owned()).await,
        1
    );
    assert_eq!(
        history_rows_by_name("0031_zippy_magma.sql".to_owned()).await,
        1
    );

    // An unrecognized name is not positional evidence and must prevent any
    // subsequent catalog-history repair.
    let ordinary_name = manifest
        .entries
        .iter()
        .find(|entry| {
            entry.file_name != "0021_chief_vindicator.sql"
                && entry.file_name != "0031_zippy_magma.sql"
        })
        .unwrap()
        .file_name
        .clone();
    sqlx::query(
        "UPDATE drizzle.__drizzle_migrations SET name = 'unknown-migration.sql' WHERE name = $1",
    )
    .bind(&ordinary_name)
    .execute(&database.pool)
    .await
    .unwrap();
    let unknown_name = apply().await;
    assert!(
        matches!(unknown_name, Err(MigrationApplyError::HistoryMismatch(_))),
        "unknown name-only history must fail closed: {unknown_name:?}"
    );
    assert_eq!(
        history_rows_by_name("0021_chief_vindicator.sql".to_owned()).await,
        1
    );
    assert_eq!(
        history_rows_by_name("0031_zippy_magma.sql".to_owned()).await,
        1
    );
    let unknown_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE name = 'unknown-migration.sql'",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(unknown_rows, 1);

    database.cleanup().await;
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
    let raw_journal: serde_json::Value =
        serde_json::from_slice(&fs::read(source.journal_path()).unwrap()).unwrap();
    let journal_entry_count = raw_journal["entries"].as_array().unwrap().len();
    let migration_count = journal_entry_count + 2;
    assert_eq!(manifest.journal.entries.len(), journal_entry_count);
    assert_eq!(manifest.entries.len(), migration_count);
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
    assert_eq!(bootstrap.applied_migrations.len(), migration_count);
    let initial_history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(initial_history_count, migration_count as i64);

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
    let mut journal = raw_journal;
    let entries = journal["entries"].as_array_mut().unwrap();
    let next_idx = entries
        .iter()
        .map(|entry| entry["idx"].as_u64().unwrap())
        .max()
        .unwrap()
        .checked_add(1)
        .unwrap();
    let next_when = entries
        .iter()
        .map(|entry| entry["when"].as_u64().unwrap())
        .max()
        .unwrap()
        .checked_add(1)
        .unwrap();
    let probe_tag = format!("{next_idx:04}_rust_apply_upgrade_probe");
    let probe_file = format!("{probe_tag}.sql");
    entries.push(json!({
        "idx": next_idx,
        "version": "7",
        "when": next_when,
        "tag": probe_tag,
        "breakpoints": true
    }));
    fs::write(
        copied_migrations.join("meta/_journal.json"),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    fs::write(
        copied_migrations.join(&probe_file),
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
    assert_eq!(upgrade.applied_migrations, [probe_file.as_str()]);
    assert!(upgrade.recovery_point.is_some());
    let upgraded_history_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(upgraded_history_count, migration_count as i64 + 1);
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
