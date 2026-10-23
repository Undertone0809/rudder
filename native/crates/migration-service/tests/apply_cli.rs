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
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::{fs::File, thread};

#[cfg(unix)]
const MANAGED_PARENT_HELPER: &str = "RUDDER_MIGRATION_APPLY_TEST_PARENT_HELPER";
#[cfg(unix)]
const MANAGED_OPERATOR_PID_FILE: &str = "RUDDER_MIGRATION_APPLY_TEST_OPERATOR_PID_FILE";
#[cfg(unix)]
const MANAGED_OPERATOR_STDOUT_FILE: &str = "RUDDER_MIGRATION_APPLY_TEST_OPERATOR_STDOUT_FILE";
#[cfg(unix)]
const MANAGED_OPERATOR_STDERR_FILE: &str = "RUDDER_MIGRATION_APPLY_TEST_OPERATOR_STDERR_FILE";
#[cfg(unix)]
const MANAGED_OPERATOR_REQUEST_FILE: &str = "RUDDER_MIGRATION_APPLY_TEST_OPERATOR_REQUEST_FILE";
#[cfg(unix)]
const MANAGED_OPERATOR_DATABASE_URL: &str = "RUDDER_MIGRATION_APPLY_TEST_OPERATOR_DATABASE_URL";

#[cfg(unix)]
#[test]
fn managed_operator_parent_helper() {
    if env::var(MANAGED_PARENT_HELPER).as_deref() != Ok("backup") {
        return;
    }

    let request = fs::read(env::var_os(MANAGED_OPERATOR_REQUEST_FILE).unwrap()).unwrap();
    let mut operator = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env(
            "RUDDER_MIGRATION_APPLY_SUPERVISOR_PID",
            std::process::id().to_string(),
        )
        .env(
            "RUDDER_MIGRATION_APPLY_DATABASE_URL",
            env::var(MANAGED_OPERATOR_DATABASE_URL).unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::from(
            File::create(env::var_os(MANAGED_OPERATOR_STDOUT_FILE).unwrap()).unwrap(),
        ))
        .stderr(Stdio::from(
            File::create(env::var_os(MANAGED_OPERATOR_STDERR_FILE).unwrap()).unwrap(),
        ))
        .spawn()
        .expect("spawn actual migration CLI for backup cancellation");
    fs::write(
        env::var_os(MANAGED_OPERATOR_PID_FILE).unwrap(),
        operator.id().to_string(),
    )
    .expect("publish operator PID");
    operator
        .stdin
        .take()
        .unwrap()
        .write_all(&request)
        .expect("send the pinned migration request");
    let _operator_waiter = thread::spawn(move || {
        operator.wait().expect("reap operator after it exits");
    });
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

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

#[cfg(unix)]
fn terminate_operator_and_assert_dump_stopped(
    request: &Value,
    database_url: &str,
    pg_dump_pid_file: &Path,
    signal_name: &str,
) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env("RUDDER_MIGRATION_APPLY_DATABASE_URL", database_url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let operator_pid = child.id();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();

    let started = Instant::now();
    while !pg_dump_pid_file.is_file() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("operator exited before starting the stub pg_dump: {status}");
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("operator did not start the stub pg_dump within 10 seconds");
        }
        thread::sleep(Duration::from_millis(20));
    }
    let pg_dump_pid = fs::read_to_string(pg_dump_pid_file)
        .unwrap()
        .trim()
        .to_owned();
    assert!(!pg_dump_pid.is_empty(), "stub pg_dump recorded its PID");

    let signaled = Command::new("kill")
        .args([signal_name, &operator_pid.to_string()])
        .status()
        .expect("Unix kill command is available");
    if !signaled.success() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("could not send SIGTERM to test-owned operator process");
    }

    let output = child.wait_with_output().unwrap();
    let body: Value =
        serde_json::from_slice(&output.stdout).expect("cancelled operator emits structured JSON");
    assert_eq!(output.status.code(), Some(2), "operator result: {body}");
    assert_eq!(body["error"]["code"], "operation_aborted");
    assert!(
        output.stderr.is_empty(),
        "operator must not log cancellation details"
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", &pg_dump_pid])
            .output()
            .expect("Unix ps command is available");
        let state = String::from_utf8_lossy(&state.stdout);
        let state = state.trim();
        if state.is_empty() || state.starts_with('Z') {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "kill_on_drop left stub pg_dump running with PID {pg_dump_pid} (state {state})"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn cancel_managed_backup_and_assert_process_group_stopped(
    request: &Value,
    database_url: &str,
    root: &Path,
) {
    use std::os::unix::fs::PermissionsExt;

    let dump_pid_file = root.join("killed-parent-pg-dump.pid");
    let grandchild_pid_file = root.join("killed-parent-pg-dump-child.pid");
    let pg_dump = root.join("blocked-pg-dump-with-grandchild");
    let recovery = root.join("killed-parent-recovery");
    let shell_path = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    fs::write(
        &pg_dump,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" > {}\nsleep 60 &\nchild=$!\nprintf '%s\\n' \"$child\" > {}\nwait \"$child\"\n",
            shell_path(&dump_pid_file),
            shell_path(&grandchild_pid_file),
        ),
    )
    .unwrap();
    fs::set_permissions(&pg_dump, fs::Permissions::from_mode(0o700)).unwrap();

    let mut managed_request = request.clone();
    managed_request["pgDumpBinary"] = pg_dump.to_str().unwrap().into();
    managed_request["recoveryDirectory"] = recovery.to_str().unwrap().into();
    let request_file = root.join("killed-parent-request.json");
    fs::write(&request_file, managed_request.to_string()).unwrap();

    let operator_pid_file = root.join("killed-parent-operator.pid");
    let stdout_file = root.join("killed-parent-operator.stdout");
    let stderr_file = root.join("killed-parent-operator.stderr");
    let mut parent = Command::new(env::current_exe().unwrap())
        .args(["--exact", "managed_operator_parent_helper", "--nocapture"])
        .env(MANAGED_PARENT_HELPER, "backup")
        .env(MANAGED_OPERATOR_PID_FILE, &operator_pid_file)
        .env(MANAGED_OPERATOR_STDOUT_FILE, &stdout_file)
        .env(MANAGED_OPERATOR_STDERR_FILE, &stderr_file)
        .env(MANAGED_OPERATOR_REQUEST_FILE, &request_file)
        .env(MANAGED_OPERATOR_DATABASE_URL, database_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn test-owned Node-shaped parent");

    let operator_pid = wait_for_test_pid_file(&operator_pid_file, &mut parent);
    let dump_pid = wait_for_test_pid_file(&dump_pid_file, &mut parent);
    let grandchild_pid = wait_for_test_pid_file(&grandchild_pid_file, &mut parent);
    assert_process_running(dump_pid, "pg_dump stub");
    assert_process_running(grandchild_pid, "pg_dump grandchild");

    // Child::kill is SIGKILL on Unix; no JavaScript or Rust parent cleanup runs.
    parent.kill().expect("SIGKILL managed parent");
    let parent_status = parent.wait().expect("wait for killed parent");
    assert!(!parent_status.success(), "parent must be killed externally");

    let receipt = wait_for_test_json(&stdout_file, operator_pid, dump_pid);
    assert_eq!(receipt["error"]["code"], "supervisor_exited");
    assert!(fs::read(stderr_file).unwrap().is_empty());
    wait_for_test_process_stopped(operator_pid, "migration operator");
    wait_for_test_process_stopped(dump_pid, "pg_dump stub");
    wait_for_test_process_stopped(grandchild_pid, "pg_dump grandchild");
}

#[cfg(unix)]
fn wait_for_test_pid_file(path: &Path, parent: &mut std::process::Child) -> u32 {
    let started = Instant::now();
    loop {
        if path.is_file() {
            return fs::read_to_string(path)
                .unwrap()
                .trim()
                .parse()
                .expect("valid process ID");
        }
        if let Some(status) = parent.try_wait().unwrap() {
            let _ = parent.wait();
            panic!("managed parent exited before process started ({status})");
        }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("timed out waiting for {}", path.display());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn process_state(pid: u32) -> String {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("Unix ps command is available");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[cfg(unix)]
fn assert_process_running(pid: u32, label: &str) {
    let state = process_state(pid);
    assert!(
        !state.is_empty() && !state.starts_with('Z'),
        "{label} must be alive before parent death; observed state {state:?}"
    );
}

#[cfg(unix)]
fn wait_for_test_process_stopped(pid: u32, label: &str) {
    let started = Instant::now();
    loop {
        let state = process_state(pid);
        if state.is_empty() || state.starts_with('Z') {
            return;
        }
        if started.elapsed() > Duration::from_secs(10) {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
                libc::kill(pid as i32, libc::SIGKILL);
            }
            panic!("{label} remains alive after managed parent death (state {state})");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn wait_for_test_json(path: &Path, operator_pid: u32, dump_pid: u32) -> Value {
    let started = Instant::now();
    loop {
        if let Ok(bytes) = fs::read(path)
            && let Ok(body) = serde_json::from_slice(&bytes)
        {
            return body;
        }
        if started.elapsed() > Duration::from_secs(20) {
            unsafe {
                libc::kill(operator_pid as i32, libc::SIGKILL);
                libc::kill(-(dump_pid as i32), libc::SIGKILL);
                libc::kill(dump_pid as i32, libc::SIGKILL);
            }
            panic!("operator did not produce parent-death receipt");
        }
        thread::sleep(Duration::from_millis(20));
    }
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
    let bootstrap_database = format!("rudder_test_bootstrap_{}_{stamp}", std::process::id());
    for name in [&database, &restored_database, &bootstrap_database] {
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
    let bootstrap_url = format!("{origin}/{bootstrap_database}");
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
    let mut bootstrap_request = request.clone();
    bootstrap_request["startupGate"] = json!({"facts":{
        "autoApplyRequested":false,
        "promptNever":false,
        "interactive":true,
        "embeddedClusterInitializedBeforeStartup":false,
        "applicationDatabaseCreated":true
    }});
    let bootstrap_result = invoke(&bootstrap_request, &bootstrap_url, true);
    assert_eq!(bootstrap_result["outcome"]["kind"], "complete");
    assert_eq!(
        bootstrap_result["outcome"]["report"]["alreadyCurrent"],
        false
    );
    assert_eq!(
        bootstrap_result["outcome"]["report"]["appliedMigrations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(bootstrap_result["outcome"]["report"]["recoveryPoint"].is_null());
    let first = invoke(&request, &database_url, true);
    assert_eq!(
        first["report"]["appliedMigrations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(first["report"]["recoveryPoint"].is_null());

    // Clone the same database snapshot so a later approval can prove that its
    // token is bound to the configured target, not only to matching schema state.
    pool.close().await;
    let approval_database = format!("rudder_test_approval_{}_{stamp}", std::process::id());
    sqlx::query(&format!(
        "CREATE DATABASE {approval_database} TEMPLATE {database}"
    ))
    .execute(&admin)
    .await
    .unwrap();
    let approval_database_url = format!("{origin}/{approval_database}");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(admin_options.clone().database(&database))
        .await
        .unwrap();

    fs::write(
        migrations.join("0001_test.sql"),
        "ALTER TABLE organizations ADD COLUMN upgrade_note text;",
    )
    .unwrap();
    request["expectedFingerprint"] = write_manifest(&migrations, 2).into();
    let mut startup_request = request.clone();
    startup_request["startupGate"] = json!({"policy":"prompt"});
    let approval_request = invoke(&startup_request, &database_url, true);
    assert_eq!(approval_request["status"], "startup");
    assert_eq!(approval_request["outcome"]["kind"], "approval-required");
    assert_eq!(
        approval_request["outcome"]["pendingMigrations"][0],
        "0001_test.sql"
    );
    let first_token = approval_request["outcome"]["stateToken"]
        .as_str()
        .expect("Rust returns a state-bound approval token")
        .to_owned();
    let mut nonempty_fresh_claim = startup_request.clone();
    nonempty_fresh_claim["startupGate"] = json!({"facts":{
        "autoApplyRequested":false,
        "promptNever":false,
        "interactive":true,
        "embeddedClusterInitializedBeforeStartup":false,
        "applicationDatabaseCreated":true
    }});
    let guarded_fresh_claim = invoke(&nonempty_fresh_claim, &database_url, true);
    assert_eq!(guarded_fresh_claim["outcome"]["kind"], "approval-required");
    assert!(
        !recovery.exists(),
        "fresh lifecycle facts cannot auto-apply a nonempty pending database"
    );
    let mut cross_target_approval = startup_request.clone();
    cross_target_approval["startupGate"]["approval"] =
        json!({"stateToken":first_token.clone(),"approved":true});
    let cross_target = invoke(&cross_target_approval, &approval_database_url, true);
    assert_eq!(cross_target["outcome"]["kind"], "stale-approval");
    assert!(
        !recovery.exists(),
        "an approval for another database must fail before backup or mutation"
    );
    let upgrade_column: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='upgrade_note')")
        .fetch_one(&pool).await.unwrap();
    assert!(
        !upgrade_column,
        "pending approval must not mutate the schema"
    );
    assert!(
        !recovery.exists(),
        "pending approval must not create a recovery dump"
    );

    // Approval is interactive and holds no database advisory lock.
    let mut lock_connection = pool.acquire().await.unwrap();
    let migration_lock_available: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext('rudder:database-migrations'))",
    )
    .fetch_one(&mut *lock_connection)
    .await
    .unwrap();
    assert!(
        migration_lock_available,
        "Rust releases the lock before returning an approval request"
    );
    let _: bool = sqlx::query_scalar(
        "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('rudder:database-migrations'))",
    )
    .fetch_one(&mut *lock_connection)
    .await
    .unwrap();
    drop(lock_connection);

    // A changed database snapshot invalidates the old approval and is checked
    // again after Rust reacquires the writer lock.
    sqlx::raw_sql("CREATE TABLE public.approval_state_change (id integer PRIMARY KEY)")
        .execute(&pool)
        .await
        .unwrap();
    let mut stale_approval = startup_request.clone();
    stale_approval["startupGate"]["approval"] =
        json!({"stateToken":first_token.clone(),"approved":true});
    let stale = invoke(&stale_approval, &database_url, true);
    assert_eq!(stale["outcome"]["kind"], "stale-approval");
    assert!(
        !recovery.exists(),
        "stale approval must fail before backup or migration"
    );

    let refreshed_request = invoke(&startup_request, &database_url, true);
    assert_eq!(refreshed_request["outcome"]["kind"], "approval-required");
    let refreshed_token = refreshed_request["outcome"]["stateToken"]
        .as_str()
        .expect("changed database state requires a fresh approval token");
    assert_ne!(refreshed_token, first_token);
    startup_request["startupGate"]["approval"] =
        json!({"stateToken":refreshed_token.to_owned(),"approved":true});
    let upgrade = invoke(&startup_request, &database_url, true);
    assert_eq!(upgrade["outcome"]["kind"], "complete");
    let backup = upgrade["outcome"]["report"]["recoveryPoint"]
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

    request["validateOnly"] = json!(true);
    let validated = invoke(&request, &database_url, true);
    assert_eq!(validated["status"], "validated");
    assert_eq!(validated["report"]["alreadyCurrent"], true);
    assert!(validated["report"]["recoveryPoint"].is_null());
    assert_eq!(
        fs::read_dir(&recovery).unwrap().count(),
        1,
        "locked validation must not create a backup"
    );

    sqlx::raw_sql(
        "CREATE TABLE public.agents (agent_runtime_type text); \
         ALTER TABLE public.agents RENAME COLUMN agent_runtime_type TO adapter_type;",
    )
    .execute(&pool)
    .await
    .unwrap();
    let requires_apply = invoke(&request, &database_url, false);
    assert_eq!(requires_apply["error"]["code"], "requires_apply");
    let legacy_column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
         WHERE table_schema='public' AND table_name='agents' AND column_name='adapter_type')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let canonical_column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
         WHERE table_schema='public' AND table_name='agents' AND column_name='agent_runtime_type')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(legacy_column, "validate-only must not rename aliases");
    assert!(
        !canonical_column,
        "validate-only must not mutate the schema"
    );

    request.as_object_mut().unwrap().remove("validateOnly");
    #[cfg(unix)]
    {
        let cancellation_fixture = temp.path().join("managed-parent-cancellation");
        fs::create_dir_all(&cancellation_fixture).unwrap();
        cancel_managed_backup_and_assert_process_group_stopped(
            &request,
            &database_url,
            &cancellation_fixture,
        );
        let legacy_after_cancel: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
             WHERE table_schema='public' AND table_name='agents' AND column_name='adapter_type')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let canonical_after_cancel: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
             WHERE table_schema='public' AND table_name='agents' AND column_name='agent_runtime_type')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            legacy_after_cancel,
            "killed parent must not apply alias repair"
        );
        assert!(
            !canonical_after_cancel,
            "cancelled backup precedes schema writes"
        );
    }
    let alias_repair = invoke(&request, &database_url, true);
    assert_eq!(
        alias_repair["report"]["normalizedLegacyColumns"],
        json!(["agents.adapter_type->agent_runtime_type"])
    );
    assert!(alias_repair["report"]["recoveryPoint"].is_string());

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

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (signal_name, case) in [("-TERM", "term"), ("-INT", "interrupt")] {
            let pid_file = temp.path().join(format!("blocking-pg-dump-{case}.pid"));
            let blocking_dump = temp.path().join(format!("blocking-pg-dump-{case}"));
            fs::write(
                &blocking_dump,
                format!(
                    "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec /bin/sleep 60\n",
                    pid_file.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&blocking_dump, fs::Permissions::from_mode(0o700)).unwrap();
            request["pgDumpBinary"] = blocking_dump.to_str().unwrap().into();
            request["recoveryDirectory"] = temp
                .path()
                .join(format!("cancelled-recovery-{case}"))
                .to_str()
                .unwrap()
                .into();
            terminate_operator_and_assert_dump_stopped(
                &request,
                &database_url,
                &pid_file,
                signal_name,
            );
        }

        let history_after_cancellation: i64 =
            sqlx::query_scalar("SELECT count(*) FROM drizzle.__drizzle_migrations")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(history_after_cancellation, 2);
        let forbidden_after_cancellation: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='forbidden_without_backup')").fetch_one(&pool).await.unwrap();
        assert!(!forbidden_after_cancellation);
    }

    restored_pool.close().await;
    pool.close().await;
    for name in [
        &database,
        &restored_database,
        &approval_database,
        &bootstrap_database,
    ] {
        sqlx::query(&format!("DROP DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
    }
    admin.close().await;
}
