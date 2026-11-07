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
const FIRST_OBSERVED_EVENT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/migrations/rust_product_analytics_collector_first_observed_event.sql"
));

#[tokio::test]
async fn migration_backfills_only_consent_supported_events_and_is_atomic_and_idempotent() {
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
        ("migration-backfill-rollup-only", "2019-01-03T00:00:00Z"),
        ("migration-backfill-unsupported", "2019-01-04T00:00:00Z"),
        ("migration-backfill-after-erasure", "2019-01-05T00:00:00Z"),
        ("migration-backfill-no-consent", "2019-01-06T00:00:00Z"),
    ] {
        sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_installations (installation_id, mode, consent_version, consent_epoch, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'anonymous', 'migration-test-v1', 0, $2::timestamptz, $2::timestamptz, now())")
            .bind(installation_id)
            .bind(first_seen_at)
            .execute(&pool)
            .await
            .expect("seed pre-existing installation");
    }

    for (
        event_id,
        installation_id,
        environment,
        is_internal,
        consent_version,
        consent_epoch,
        occurred_at,
    ) in [
        (
            "00000000-0000-4000-8000-000000000001",
            "migration-backfill-candidate",
            "production",
            false,
            "migration-test-v1",
            1,
            "2024-03-01T12:34:56.123456Z",
        ),
        (
            "00000000-0000-4000-8000-000000000002",
            "migration-backfill-candidate",
            "production",
            false,
            "migration-test-v1",
            1,
            "2024-03-03T12:34:56.654321Z",
        ),
        (
            "00000000-0000-4000-8000-000000000003",
            "migration-backfill-candidate",
            "production",
            true,
            "migration-test-v1",
            1,
            "2024-02-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000004",
            "migration-backfill-candidate",
            "development",
            false,
            "migration-test-v1",
            1,
            "2020-01-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000005",
            "migration-backfill-candidate",
            "production",
            false,
            "",
            1,
            "2022-01-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000006",
            "migration-backfill-candidate",
            "production",
            false,
            "migration-test-v1",
            0,
            "2021-01-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000007",
            "migration-backfill-ineligible",
            "production",
            true,
            "migration-test-v1",
            1,
            "2023-01-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000008",
            "migration-backfill-ineligible",
            "development",
            false,
            "migration-test-v1",
            1,
            "2020-01-01T00:00:00Z",
        ),
    ] {
        sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_events (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, is_internal, confidence, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, 'organization_created', 1, $3::timestamptz, $3::timestamptz, $4, 'migration-test', 'stable', 'desktop_local', 'user', 'human', $5, 'exact', $6, $7, repeat('a', 64))")
            .bind(event_id)
            .bind(installation_id)
            .bind(occurred_at)
            .bind(environment)
            .bind(is_internal)
            .bind(consent_version)
            .bind(consent_epoch)
            .execute(&pool)
            .await
            .expect("seed pre-existing telemetry event");
    }

    for (event_id, installation_id, event_name, schema_version, occurred_at) in [
        (
            "00000000-0000-4000-8000-000000000009",
            "migration-backfill-candidate",
            "unsupported_event",
            1,
            "2024-02-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000010",
            "migration-backfill-candidate",
            "organization_created",
            2,
            "2024-02-02T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000011",
            "migration-backfill-unsupported",
            "unsupported_event",
            1,
            "2024-01-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000012",
            "migration-backfill-unsupported",
            "organization_created",
            2,
            "2024-01-02T00:00:00Z",
        ),
    ] {
        sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_events (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, is_internal, confidence, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $5::timestamptz, 'production', 'migration-test', 'stable', 'desktop_local', 'user', 'human', false, 'exact', 'migration-test-v1', 1, repeat('c', 64))")
            .bind(event_id)
            .bind(installation_id)
            .bind(event_name)
            .bind(schema_version)
            .bind(occurred_at)
            .execute(&pool)
            .await
            .expect("seed unsupported historical telemetry event");
    }

    for (event_id, consent_version, consent_epoch) in [
        ("00000000-0000-4000-8000-000000000015", "", 1),
        (
            "00000000-0000-4000-8000-000000000016",
            "migration-test-v1",
            0,
        ),
    ] {
        sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_events (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, is_internal, confidence, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, 'migration-backfill-no-consent', 'organization_created', 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'production', 'migration-test', 'stable', 'desktop_local', 'user', 'human', false, 'exact', $2, $3, repeat('e', 64))")
            .bind(event_id)
            .bind(consent_version)
            .bind(consent_epoch)
            .execute(&pool)
            .await
            .expect("seed event with unsupported consent state");
    }
    let too_long_consent_version = "v".repeat(81);
    sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_events (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, is_internal, confidence, consent_version, consent_epoch, payload_sha256) VALUES ('00000000-0000-4000-8000-000000000017'::uuid, 'migration-backfill-no-consent', 'organization_created', 1, '2024-01-02T00:00:00Z', '2024-01-02T00:00:00Z', 'production', 'migration-test', 'stable', 'desktop_local', 'user', 'human', false, 'exact', $1, 1, repeat('f', 64))")
        .bind(too_long_consent_version)
        .execute(&pool)
        .await
        .expect("seed event with overlong consent version");

    for (event_id, subject, event_name, schema_version, occurred_at) in [
        (
            "00000000-0000-4000-8000-000000000013",
            Some("migration-erasure-subject"),
            "organization_created",
            1,
            "2024-03-01T00:00:00Z",
        ),
        (
            "00000000-0000-4000-8000-000000000014",
            None,
            "unsupported_event",
            1,
            "2024-02-01T00:00:00Z",
        ),
    ] {
        sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_events (event_id, installation_id, analytics_subject, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, is_internal, confidence, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, 'migration-backfill-after-erasure', $2, $3, $4, $5::timestamptz, $5::timestamptz, 'production', 'migration-test', 'stable', 'desktop_local', 'user', 'human', false, 'exact', 'migration-test-v1', 1, repeat('d', 64))")
            .bind(event_id)
            .bind(subject)
            .bind(event_name)
            .bind(schema_version)
            .bind(occurred_at)
            .execute(&pool)
            .await
            .expect("seed subject-erasure cohort fixture");
    }

    sqlx::query("INSERT INTO rudder_analytics.product_analytics_collector_daily_rollups (day, installation_id, event_name, origin, dimension_hash, dimensions, event_count, first_occurred_at, last_occurred_at) VALUES ('2018-01-01', 'migration-backfill-rollup-only', 'organization_created', 'human', repeat('f', 64), '{\"environment\":\"production\"}'::jsonb, 1, '2018-01-01T00:00:00Z', '2018-01-01T00:00:00Z')")
        .execute(&pool)
        .await
        .expect("seed a production rollup without raw consent provenance");

    let column_absent_before_migration: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='rudder_analytics' AND table_name='product_analytics_collector_installations' AND column_name='first_observed_event_at')",
    )
    .fetch_one(&pool)
    .await
    .expect("check legacy schema before migration");
    assert!(column_absent_before_migration);

    sqlx::query("CREATE FUNCTION rudder_analytics.reject_first_observed_backfill() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RAISE EXCEPTION 'forced first-observed migration failure'; END; $function$")
        .execute(&pool)
        .await
        .expect("create rollback fixture trigger function");
    sqlx::query("CREATE TRIGGER reject_first_observed_backfill BEFORE UPDATE OF first_observed_event_at ON rudder_analytics.product_analytics_collector_installations FOR EACH ROW EXECUTE FUNCTION rudder_analytics.reject_first_observed_backfill()")
        .execute(&pool)
        .await
        .expect("create rollback fixture trigger");

    let config = MigrationConfig {
        database_url: postgres.database_url.clone(),
        expected_role: "postgres".into(),
        collector_role: "rudder_analytics_collector".into(),
        rollup_role: "rudder_analytics_rollup".into(),
        reader_role: "rudder_analytics_reader".into(),
    };
    let failed_upgrade = migrate(&config).await;
    assert!(
        failed_upgrade.is_err(),
        "the injected migration failure must surface"
    );
    let column_absent_after_rollback: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='rudder_analytics' AND table_name='product_analytics_collector_installations' AND column_name='first_observed_event_at')",
    )
    .fetch_one(&pool)
    .await
    .expect("check failed migration rolled back DDL");
    assert!(
        column_absent_after_rollback,
        "failed migration must roll back its added column"
    );
    let failed_tag_recorded: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM rudder_analytics._product_analytics_migrations WHERE tag='rust_product_analytics_collector_first_observed_event.sql')",
    )
    .fetch_one(&pool)
    .await
    .expect("check failed migration history");
    assert!(
        !failed_tag_recorded,
        "failed migration must not commit its history tag"
    );
    sqlx::query("DROP TRIGGER reject_first_observed_backfill ON rudder_analytics.product_analytics_collector_installations")
        .execute(&pool)
        .await
        .expect("remove rollback fixture trigger");
    sqlx::query("DROP FUNCTION rudder_analytics.reject_first_observed_backfill()")
        .execute(&pool)
        .await
        .expect("remove rollback fixture trigger function");

    migrate(&config)
        .await
        .expect("retry the real collector migration after rollback");
    assert_migration_ownership(&pool).await;

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
        "invalid consent, internal and non-production rows must not establish the cohort timestamp"
    );

    let unsupported_events_left_null: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at IS NULL FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id='migration-backfill-unsupported'",
    )
    .fetch_one(&pool)
    .await
    .expect("read installation with only unsupported events");
    assert!(
        unsupported_events_left_null,
        "unsupported event names and schema versions must not establish the cohort timestamp"
    );

    let unsupported_consent_left_null: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at IS NULL FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id='migration-backfill-no-consent'",
    )
    .fetch_one(&pool)
    .await
    .expect("read installation with only unsupported consent states");
    assert!(
        unsupported_consent_left_null,
        "empty, overlong, and nonpositive consent states must not establish the cohort timestamp"
    );

    let supported_event_established_erasure_fixture: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at = '2024-03-01T00:00:00Z'::timestamptz FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id='migration-backfill-after-erasure'",
    )
    .fetch_one(&pool)
    .await
    .expect("read supported event cohort before subject erasure");
    assert!(supported_event_established_erasure_fixture);
    sqlx::query(
        "SELECT rudder_analytics.erase_product_analytics_subject('migration-erasure-subject')",
    )
    .execute(&pool)
    .await
    .expect("erase subject and recalculate remaining cohort events");
    let unsupported_event_did_not_reanchor_after_erasure: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at IS NULL FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id='migration-backfill-after-erasure'",
    )
    .fetch_one(&pool)
    .await
    .expect("read cohort after supported event erasure");
    assert!(
        unsupported_event_did_not_reanchor_after_erasure,
        "subject erasure must not re-anchor a cohort from an unsupported event"
    );

    let rollup_only_left_null: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at IS NULL FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id='migration-backfill-rollup-only'",
    )
    .fetch_one(&pool)
    .await
    .expect("read installation represented only by a legacy rollup");
    assert!(
        rollup_only_left_null,
        "rollups without consent provenance cannot establish a cohort"
    );

    migrate(&config)
        .await
        .expect("repeated migration startup must be idempotent");
    let applied_count: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM rudder_analytics._product_analytics_migrations",
    )
    .fetch_one(&pool)
    .await
    .expect("count migration history after repeated startup");
    assert_eq!(applied_count, 5);

    let preserved = "2024-02-15T01:02:03Z";
    sqlx::query("UPDATE rudder_analytics.product_analytics_collector_installations SET first_observed_event_at=$2::timestamptz WHERE installation_id='migration-backfill-candidate'")
        .bind(preserved)
        .execute(&pool)
        .await
        .expect("seed a previously persisted cohort timestamp");
    apply_migration(&pool, FIRST_OBSERVED_EVENT).await;
    let prior_value_preserved: bool = sqlx::query_scalar(
        "SELECT first_observed_event_at = $2::timestamptz FROM rudder_analytics.product_analytics_collector_installations WHERE installation_id='migration-backfill-candidate'",
    )
    .bind(preserved)
    .fetch_one(&pool)
    .await
    .expect("read cohort after direct idempotent migration replay");
    assert!(
        prior_value_preserved,
        "migration replay must not overwrite an existing cohort timestamp"
    );

    pool.close().await;
}

async fn assert_migration_ownership(pool: &PgPool) {
    let schema_owned_by_migrator: bool = sqlx::query_scalar(
        "SELECT n.nspowner = r.oid FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.rolname='postgres' WHERE n.nspname='rudder_analytics'",
    )
    .fetch_one(pool)
    .await
    .expect("read analytics schema owner");
    assert!(
        schema_owned_by_migrator,
        "analytics schema must be owned by the configured migration role"
    );
    let object_owner_mismatch: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rudder_analytics' AND c.relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres')) OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rudder_analytics' AND p.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres')) OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='rudder_analytics' AND t.typowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='postgres'))",
    )
    .fetch_one(pool)
    .await
    .expect("read analytics object owners");
    assert!(
        !object_owner_mismatch,
        "analytics SQL objects must be owned by the configured migration role"
    );
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
