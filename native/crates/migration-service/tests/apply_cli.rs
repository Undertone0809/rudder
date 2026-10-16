//! Real operator workflow. Explicit opt-in administrator URL must point to a
//! disposable cluster; this test creates and drops only its own databases.
use rudder_migration_core::{MigrationLimits, load_migration_manifest};
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::{
    env, fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

fn write_manifest(path: &Path, count: usize) -> String {
    fs::create_dir_all(path.join("meta")).unwrap();
    let entries: Vec<_> = (0..count).map(|index| json!({
        "idx": index, "version": "7", "when": 1000 + index, "tag": format!("{index:04}_test"), "breakpoints": true,
    })).collect();
    fs::write(
        path.join("meta/_journal.json"),
        json!({"version":"7", "dialect":"postgresql", "entries":entries}).to_string(),
    )
    .unwrap();
    load_migration_manifest(
        &path.join("meta/_journal.json"),
        path,
        MigrationLimits::default(),
    )
    .unwrap()
    .fingerprint
}

fn invoke(request: &Value, database_url: &str, succeeds: bool) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env("RUDDER_MIGRATION_APPLY_DATABASE_URL", database_url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    let body: Value =
        serde_json::from_slice(&result.stdout).expect("operator emits structured JSON");
    assert_eq!(result.status.success(), succeeds, "operator result: {body}");
    assert!(
        result.stderr.is_empty(),
        "operator must not log database or subprocess errors"
    );
    body
}

#[cfg(unix)]
fn write_stub_pg_dump(path: &Path, output: &str) {
    use std::os::unix::fs::PermissionsExt;

    fs::write(
        path,
        format!("#!/bin/sh\ncat <<'RUDDER_TEST_DUMP'\n{output}\nRUDDER_TEST_DUMP\n"),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[tokio::test]
#[ignore = "requires disposable RUDDER_MIGRATION_APPLY_TEST_ADMIN_URL and RUDDER_TEST_PG_DUMP / RUDDER_TEST_PSQL"]
async fn native_operator_applies_upgrades_and_restores_real_recovery_point() {
    let admin_url = env::var("RUDDER_MIGRATION_APPLY_TEST_ADMIN_URL")
        .expect("explicit disposable cluster required");
    let pg_dump = env::var("RUDDER_TEST_PG_DUMP").expect("matching pg_dump required");
    let psql = env::var("RUDDER_TEST_PSQL").expect("matching psql required");
    assert!(Path::new(&pg_dump).is_absolute() && Path::new(&psql).is_absolute());
    let admin_options = PgConnectOptions::from_str(&admin_url).unwrap();
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(admin_options.clone())
        .await
        .unwrap();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let database = format!("rudder_test_apply_{}_{stamp}", std::process::id());
    let restored_database = format!("rudder_test_restore_{}_{stamp}", std::process::id());
    for name in [&database, &restored_database] {
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
    }
    // Use the library parser to retain host/user/SSL settings, and replace only
    // the database name in a fresh options object. CLI URL construction accepts
    // ordinary postgres URLs used by the explicitly provisioned test cluster.
    let (origin, _) = admin_url
        .rsplit_once('/')
        .expect("postgres URL with database name");
    assert!(
        !admin_url.contains('?'),
        "fixture administrator URL must omit query parameters"
    );
    let database_url = format!("{origin}/{database}");
    let restored_url = format!("{origin}/{restored_database}");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(admin_options.clone().database(&database))
        .await
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let migrations = temp.path().join("migrations");
    let recovery = temp.path().join("recovery");
    fs::create_dir_all(&migrations).unwrap();
    fs::write(migrations.join("0000_test.sql"), "CREATE TABLE organizations (id text PRIMARY KEY);\n--> statement-breakpoint\nCREATE TABLE preserved_rows (id integer PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id));\n--> statement-breakpoint\nINSERT INTO organizations VALUES ('preserved-org');\n--> statement-breakpoint\nINSERT INTO preserved_rows VALUES (42, 'preserved-org');").unwrap();
    let fingerprint = write_manifest(&migrations, 1);
    let mut request = json!({"schema":"rudder.migration-apply/v1","protocolVersion":1,"allowApply":true,"migrationsDir":migrations,"expectedFingerprint":fingerprint,"recoveryDirectory":recovery,"pgDumpBinary":pg_dump});
    let first = invoke(&request, &database_url, true);
    assert_eq!(
        first["report"]["appliedMigrations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(first["report"]["recoveryPoint"].is_null());

    fs::write(
        migrations.join("0001_test.sql"),
        "ALTER TABLE organizations ADD COLUMN upgrade_note text;",
    )
    .unwrap();
    request["expectedFingerprint"] = write_manifest(&migrations, 2).into();
    let upgrade = invoke(&request, &database_url, true);
    let backup = upgrade["report"]["recoveryPoint"]
        .as_str()
        .expect("non-empty upgrade keeps recovery SQL");
    assert!(Path::new(backup).is_file());
    let restored = Command::new(&psql)
        .arg("--dbname")
        .arg(&restored_url)
        .args(["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--file", backup])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        restored.status.success(),
        "recovery SQL must actually restore in a fresh database"
    );
    let restored_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(admin_options.database(&restored_database))
        .await
        .unwrap();
    let restored_row: (i32, String) = sqlx::query_as("SELECT id, org_id FROM preserved_rows")
        .fetch_one(&restored_pool)
        .await
        .unwrap();
    assert_eq!(restored_row, (42, "preserved-org".to_owned()));
    let before_column: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='upgrade_note')").fetch_one(&restored_pool).await.unwrap();
    assert!(!before_column, "backup represents pre-upgrade schema");
    let restored_history: i64 =
        sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(&restored_pool)
            .await
            .unwrap();
    assert_eq!(restored_history, 1, "backup includes pre-upgrade journal");
    assert_eq!(
        invoke(&request, &database_url, true)["report"]["alreadyCurrent"],
        true
    );
    assert_eq!(
        fs::read_dir(&recovery).unwrap().count(),
        1,
        "retry must not create an unnecessary backup"
    );

    fs::write(
        migrations.join("0002_test.sql"),
        "ALTER TABLE organizations ADD COLUMN forbidden_without_backup text;",
    )
    .unwrap();
    request["expectedFingerprint"] = write_manifest(&migrations, 3).into();
    request["pgDumpBinary"] = temp.path().join("missing-pg-dump").to_str().unwrap().into();
    assert_eq!(
        invoke(&request, &database_url, false)["error"]["code"],
        "recovery_point_failed"
    );
    let history: i64 = sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(history, 2);
    let forbidden: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='forbidden_without_backup')").fetch_one(&pool).await.unwrap();
    assert!(
        !forbidden,
        "backup failure must precede every migration write"
    );

    #[cfg(unix)]
    for (case, output) in [
        ("empty", ""),
        (
            "unrelated",
            "-- PostgreSQL database dump\nCREATE TABLE public.unrelated (id integer);\nCOPY public.unrelated (id) FROM stdin;\n1\n\\.\n-- PostgreSQL database dump complete",
        ),
    ] {
        let stub = temp.path().join(format!("pg-dump-{case}"));
        write_stub_pg_dump(&stub, output);
        request["pgDumpBinary"] = stub.to_str().unwrap().into();
        request["recoveryDirectory"] = temp
            .path()
            .join(format!("invalid-recovery-{case}"))
            .to_str()
            .unwrap()
            .into();
        assert_eq!(
            invoke(&request, &database_url, false)["error"]["code"],
            "recovery_point_invalid",
            "a zero-exit {case} dump must not authorize migration writes"
        );
        let history_after_invalid_dump: i64 =
            sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(history_after_invalid_dump, 2);
        let forbidden_after_invalid_dump: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='forbidden_without_backup')").fetch_one(&pool).await.unwrap();
        assert!(!forbidden_after_invalid_dump);
    }

    restored_pool.close().await;
    pool.close().await;
    for name in [&database, &restored_database] {
        sqlx::query(&format!("DROP DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
    }
    admin.close().await;
}
