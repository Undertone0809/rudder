use rudder_product_analytics_collector_core::{MigrationConfig, migrate};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    env, fs,
    net::TcpListener,
    path::PathBuf,
    process::{Command, id},
    time::{SystemTime, UNIX_EPOCH},
};

const INITIAL_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/db/src/migrations/0140_faulty_kitty_pryde.sql"
));
const REVISION_ORIGIN: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/db/src/migrations/0141_product_analytics_revision_origin.sql"
));
const QUALITY_COUNTERS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/db/src/migrations/0142_product_analytics_quality_counters.sql"
));

#[tokio::test]
async fn migration_backfills_exact_earliest_production_non_internal_event() {
    let postgres = PostgresHarness::start();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&postgres.database_url)
        .await
        .expect("connect temporary migration database");

    for role in [
        "rudder_analytics_collector",
        "rudder_analytics_rollup",
        "rudder_analytics_reader",
    ] {
        sqlx::query(&format!("CREATE ROLE {role} NOLOGIN"))
            .execute(&pool)
            .await
            .expect("create isolated analytics role");
    }

    apply_migration(&pool, INITIAL_SCHEMA).await;
    apply_migration(&pool, REVISION_ORIGIN).await;
    apply_migration(&pool, QUALITY_COUNTERS).await;
    sqlx::query("CREATE TABLE rudder_analytics._product_analytics_migrations (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        .execute(&pool)
        .await
        .expect("create migration history for pre-existing schema");
    sqlx::query("INSERT INTO rudder_analytics._product_analytics_migrations (tag) VALUES ('0140_faulty_kitty_pryde.sql'), ('0141_product_analytics_revision_origin.sql'), ('0142_product_analytics_quality_counters.sql')")
        .execute(&pool)
        .await
        .expect("record existing schema migrations");

    for (installation_id, first_seen_at) in [
        ("migration-backfill-candidate", "2019-01-01T00:00:00Z"),
        ("migration-backfill-ineligible", "2019-01-02T00:00:00Z"),
    ] {
        sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_installations (installation_id, mode, consent_version, consent_epoch, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'anonymous', 'migration-test-v1', 0, $2::timestamptz, $2::timestamptz, now())")
            .bind(installation_id)
            .bind(first_seen_at)
            .execute(&pool)
            .await
            .expect("seed pre-existing installation");
    }

    for (event_id, installation_id, environment, is_internal, occurred_at) in [
        (
            "00000000-0000-4000-8000-000000000001",
            "migration-backfill-candidate",
            "production",
            false,
            "2024-03-01T12:34:56.123456Z",
        ),
        (
            "00000000-0000-4000-8000-000000000002",
            "migration-backfill-candidate",
            "production",
            false,
            "2024-03-03T12:34:56.654321Z",
        ),
        (
            "00000000-0000-4000-8000-000000000003",
            "migration-backfill-candidate",
            "production",
            true,
            "2024-02-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000004",
            "migration-backfill-candidate",
            "development",
            false,
            "2020-01-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000005",
            "migration-backfill-ineligible",
            "production",
            true,
            "2023-01-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000006",
            "migration-backfill-ineligible",
            "development",
            false,
            "2020-01-01T00:00:00Z",
        ),
    ] {
        sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_events (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, is_internal, confidence, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, 'organization_created', 1, $3::timestamptz, $3::timestamptz, $4, 'migration-test', 'stable', 'desktop_local', 'user', 'human', $5, 'exact', 'migration-test-v1', 0, repeat('a', 64))")
            .bind(event_id)
            .bind(installation_id)
            .bind(occurred_at)
            .bind(environment)
            .bind(is_internal)
            .execute(&pool)
            .await
            .expect("seed pre-existing telemetry event");
    }

    let column_absent_before_migration: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='rudder_analytics' AND table_name='product_analytics_collector_installations' AND column_name='first_observed_event_at')",
    )
    .fetch_one(&pool)
    .await
    .expect("check legacy schema before migration");
    assert!(column_absent_before_migration);

    migrate(&MigrationConfig {
        database_url: postgres.database_url.clone(),
        expected_role: Some("postgres".into()),
        collector_role: "rudder_analytics_collector".into(),
        rollup_role: "rudder_analytics_rollup".into(),
        reader_role: "rudder_analytics_reader".into(),
    })
    .await
    .expect("run the real collector migration entry point");

    let earliest_event_matches: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at = $2::timestamptz FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id=$1",
    )
    .bind("migration-backfill-candidate")
    .bind("2024-03-01T12:34:56.123456Z")
    .fetch_one(&pool)
    .await
    .expect("read exact backfilled production event timestamp");
    assert!(
        earliest_event_matches,
        "backfill must select the exact earliest production non-internal event"
    );

    let no_eligible_event_left_null: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at IS NULL FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id='migration-backfill-ineligible'",
    )
    .fetch_one(&pool)
    .await
    .expect("read installation with no eligible production event");
    assert!(
        no_eligible_event_left_null,
        "internal and non-production rows must not establish the cohort timestamp"
    );

    pool.close().await;
}

async fn apply_migration(pool: &PgPool, migration: &str) {
    for statement in migration
        .split("--> statement-breakpoint")
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
    {
        sqlx::query(statement)
            .execute(pool)
            .await
            .unwrap_or_else(|error| panic!("apply pre-existing schema migration: {error}"));
    }
}

struct PostgresHarness {
    root_dir: PathBuf,
    data_dir: PathBuf,
    pg_ctl: PathBuf,
    database_url: String,
}

impl PostgresHarness {
    fn start() -> Self {
        let initdb = postgres_binary("initdb");
        let pg_ctl = postgres_binary("pg_ctl");
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        let root_dir =
            env::temp_dir().join(format!("rudder-analytics-migration-{}-{unique}", id()));
        fs::create_dir(&root_dir).expect("create temporary PostgreSQL directory");
        let data_dir = root_dir.join("data");
        let log_path = root_dir.join("postgres.log");
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("reserve a loopback port")
            .local_addr()
            .expect("read loopback port")
            .port();
        run_checked(
            Command::new(initdb).arg("-D").arg(&data_dir).args([
                "--encoding=UTF8",
                "--locale=C",
                "--auth=trust",
                "--username=postgres",
                "--no-sync",
            ]),
            "initdb",
        );
        let output = Command::new(&pg_ctl)
            .arg("-D")
            .arg(&data_dir)
            .arg("-l")
            .arg(&log_path)
            .arg("-o")
            .arg(format!("-h 127.0.0.1 -p {port} -F -k /tmp"))
            .args(["-w", "start"])
            .output()
            .expect("run pg_ctl start");
        assert!(
            output.status.success(),
            "pg_ctl start failed: stdout={} stderr={} log={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
            fs::read_to_string(&log_path).unwrap_or_default()
        );
        Self {
            root_dir,
            data_dir,
            pg_ctl,
            database_url: format!("postgresql://postgres@127.0.0.1:{port}/postgres"),
        }
    }
}

impl Drop for PostgresHarness {
    fn drop(&mut self) {
        let _ = Command::new(&self.pg_ctl)
            .arg("-D")
            .arg(&self.data_dir)
            .args(["-m", "immediate", "-w", "stop"])
            .status();
        let _ = fs::remove_dir_all(&self.root_dir);
    }
}

fn postgres_binary(name: &str) -> PathBuf {
    let executable = format!("{name}{}", env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();
    if let Some(bin_dir) = env::var_os("RUDDER_POSTGRES_BIN_DIR") {
        candidates.push(PathBuf::from(bin_dir).join(&executable));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|directory| directory.join(&executable)));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin").join(&executable),
        PathBuf::from("/usr/local/bin").join(&executable),
    ]);
    if let Ok(versions) = fs::read_dir("/usr/lib/postgresql") {
        candidates.extend(
            versions
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(&executable)),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("PostgreSQL test binary {name} was not found"))
}

fn run_checked(command: &mut Command, label: &str) {
    let output = command
        .output()
        .unwrap_or_else(|error| panic!("run {label}: {error}"));
    assert!(
        output.status.success(),
        "{label} failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
