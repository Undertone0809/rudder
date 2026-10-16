//! Explicit operator entrypoint; never starts implicitly from preflight.
use rudder_migration_core::{
    MigrationInspectionOptions, MigrationManifestOptions, MigrationSource, inspect_migration_source,
};
use rudder_migration_service::{MigrationApplyService, MigrationRecoveryPointReceipt};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::Stdio,
    str::FromStr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;

const SCHEMA: &str = "rudder.migration-apply/v1";
const MAX_INPUT: u64 = 256 * 1024;
const MAX_BACKUP: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    schema: String,
    protocol_version: u8,
    allow_apply: bool,
    migrations_dir: PathBuf,
    expected_fingerprint: String,
    recovery_directory: PathBuf,
    pg_dump_binary: PathBuf,
}

fn absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
}

fn parse(input: &[u8]) -> Result<Request, &'static str> {
    let request: Request = serde_json::from_slice(input).map_err(|_| "invalid_request")?;
    if request.schema != SCHEMA || request.protocol_version != 1 || !request.allow_apply {
        return Err("explicit_apply_contract_required");
    }
    if !absolute_path(&request.migrations_dir)
        || !absolute_path(&request.recovery_directory)
        || !absolute_path(&request.pg_dump_binary)
    {
        return Err("absolute_normalized_paths_required");
    }
    if request.expected_fingerprint.len() != 64
        || !request
            .expected_fingerprint
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("manifest_fingerprint_required");
    }
    Ok(request)
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("migration-apply {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let result = run().await;
    let failed = result.is_err();
    let output = match result {
        Ok(report) => {
            serde_json::json!({"schema": SCHEMA, "protocolVersion": 1, "status": "applied", "report": report})
        }
        // Do not emit SQL, connection strings, subprocess stderr or secrets.
        Err(code) => {
            serde_json::json!({"schema": SCHEMA, "protocolVersion": 1, "status": "error", "error": {"code": code}})
        }
    };
    println!("{output}");
    if failed {
        std::process::exit(2);
    }
}

async fn run() -> Result<rudder_migration_service::MigrationApplyReport, &'static str> {
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut input)
        .map_err(|_| "stdin_read_failed")?;
    if input.len() as u64 > MAX_INPUT {
        return Err("input_too_large");
    }
    let request = parse(&input)?;
    let source = MigrationSource::new(&request.migrations_dir);
    let manifest = inspect_migration_source(
        &source,
        &MigrationInspectionOptions {
            manifest: MigrationManifestOptions::default(),
            expected_fingerprint: Some(request.expected_fingerprint),
        },
    )
    .map_err(|_| "migration_source_invalid")?;
    if !manifest.validate_integrity().valid {
        return Err("migration_manifest_invalid");
    }
    let database_url =
        std::env::var("RUDDER_MIGRATION_APPLY_DATABASE_URL").map_err(|_| "database_url_missing")?;
    if database_url.len() > 8192
        || !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://"))
    {
        return Err("database_url_invalid");
    }
    let options = PgConnectOptions::from_str(&database_url)
        .map_err(|_| "database_url_invalid")?
        .application_name("rudder-migration-apply");
    let pool = tokio::time::timeout(
        Duration::from_secs(5),
        PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options),
    )
    .await
    .map_err(|_| "database_connect_failed")?
    .map_err(|_| "database_connect_failed")?;
    let backup_pool = pool.clone();
    let result = MigrationApplyService::new(pool.clone()).apply_pending_migrations(&manifest, &source, || async move {
        let schema: Option<String> = sqlx::query_scalar("SELECT table_schema FROM information_schema.tables WHERE table_name = '__drizzle_migrations' AND table_schema IN ('drizzle', 'public') ORDER BY CASE WHEN table_schema = 'drizzle' THEN 0 ELSE 1 END LIMIT 1")
            .fetch_optional(&backup_pool).await.map_err(|_| "backup_journal_lookup_failed".to_owned())?;
        let schema = schema.ok_or_else(|| "backup_journal_missing".to_owned())?;
        create_backup(&request.recovery_directory, &request.pg_dump_binary, &database_url, &schema)
            .await.map_err(str::to_owned)
    }).await;
    pool.close().await;
    result.map_err(|error| match error {
        rudder_migration_service::MigrationApplyError::ManifestChanged => {
            "migration_source_changed"
        }
        rudder_migration_service::MigrationApplyError::RecoveryPointProvider(_) => {
            "recovery_point_failed"
        }
        rudder_migration_service::MigrationApplyError::InvalidRecoveryPoint(_) => {
            "recovery_point_invalid"
        }
        rudder_migration_service::MigrationApplyError::UnsafeLegacyDatabase => {
            "unsafe_legacy_database"
        }
        _ => "migration_apply_failed",
    })
}

// libpq does not expand a URI supplied through PGDATABASE. Derive explicit
// environment settings instead; passwords never appear in child arguments.
fn backup_connection_env(database_url: &str) -> Result<Vec<(String, String)>, &'static str> {
    let url = url::Url::parse(database_url).map_err(|_| "database_url_invalid")?;
    let options = PgConnectOptions::from_str(database_url).map_err(|_| "database_url_invalid")?;
    let host = options
        .get_socket()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| options.get_host().to_owned());
    let mut values = vec![
        ("PGHOST".into(), host),
        ("PGPORT".into(), options.get_port().to_string()),
        ("PGUSER".into(), options.get_username().to_owned()),
        (
            "PGDATABASE".into(),
            options
                .get_database()
                .unwrap_or(options.get_username())
                .to_owned(),
        ),
        ("PGCONNECT_TIMEOUT".into(), "5".into()),
        (
            "PGSSLMODE".into(),
            match options.get_ssl_mode() {
                sqlx::postgres::PgSslMode::Disable => "disable",
                sqlx::postgres::PgSslMode::Allow => "allow",
                sqlx::postgres::PgSslMode::Prefer => "prefer",
                sqlx::postgres::PgSslMode::Require => "require",
                sqlx::postgres::PgSslMode::VerifyCa => "verify-ca",
                sqlx::postgres::PgSslMode::VerifyFull => "verify-full",
            }
            .into(),
        ),
    ];
    if let Some(password) = url.password() {
        values.push((
            "PGPASSWORD".into(),
            percent_encoding::percent_decode_str(password)
                .decode_utf8()
                .map_err(|_| "database_url_invalid")?
                .into_owned(),
        ));
    }
    if let Some(options) = options.get_options() {
        values.push(("PGOPTIONS".into(), options.to_owned()));
    }
    for (key, value) in url.query_pairs() {
        let env_key = match key.as_ref() {
            "password" => "PGPASSWORD",
            "sslrootcert" | "ssl-root-cert" | "ssl-ca" => "PGSSLROOTCERT",
            "sslcert" | "ssl-cert" => "PGSSLCERT",
            "sslkey" | "ssl-key" => "PGSSLKEY",
            _ => continue,
        };
        values.push((env_key.into(), value.into_owned()));
    }
    Ok(values)
}

async fn create_backup(
    directory: &Path,
    binary: &Path,
    database_url: &str,
    _journal_schema: &str,
) -> Result<MigrationRecoveryPointReceipt, &'static str> {
    // This operator-selected directory is private. Reject a symlink as its
    // final component and never truncate an existing recovery point.
    fs::create_dir_all(directory).map_err(|_| "backup_directory_failed")?;
    if fs::symlink_metadata(directory)
        .map_err(|_| "backup_directory_failed")?
        .file_type()
        .is_symlink()
    {
        return Err("backup_directory_symlink");
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "clock_invalid")?
        .as_nanos();
    let filename = format!("pre-migration-{stamp}-{}.sql", std::process::id());
    let final_path = directory.join(&filename);
    let partial = directory.join(format!("{filename}.partial"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&partial).map_err(|_| "backup_file_failed")?;
    writeln!(file, "-- Rudder database backup\n-- Full PostgreSQL SQL dump follows; retain until upgrade acceptance.").map_err(|_| "backup_file_failed")?;
    // Connection credentials remain in the child environment, never argv or
    // logs. The full dump includes the journal and all application schemas.
    let mut command = Command::new(binary);
    command.env_remove("RUDDER_MIGRATION_APPLY_DATABASE_URL");
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("PG") {
            command.env_remove(name);
        }
    }
    let mut child = command
        .args([
            "--format=plain",
            "--no-owner",
            "--no-privileges",
            "--no-password",
        ])
        .envs(backup_connection_env(database_url)?)
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "backup_process_failed")?;
    let started = tokio::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "backup_process_failed")? {
            break status;
        }
        let too_large = fs::metadata(&partial)
            .map_err(|_| "backup_read_failed")?
            .len()
            > MAX_BACKUP;
        if too_large || started.elapsed() > Duration::from_secs(600) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(if too_large {
                "backup_size_invalid"
            } else {
                "backup_timeout"
            });
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    if !status.success() {
        return Err("backup_process_failed");
    }
    tokio::task::spawn_blocking(move || finish_backup(&partial, &final_path))
        .await
        .map_err(|_| "backup_finalize_failed")?
}

fn finish_backup(
    partial: &Path,
    final_path: &Path,
) -> Result<MigrationRecoveryPointReceipt, &'static str> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(partial)
        .map_err(|_| "backup_read_failed")?;
    let size = file.metadata().map_err(|_| "backup_read_failed")?.len();
    if size == 0 || size > MAX_BACKUP {
        return Err("backup_size_invalid");
    }
    file.sync_all().map_err(|_| "backup_sync_failed")?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let length = file.read(&mut buffer).map_err(|_| "backup_read_failed")?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    // Hard-link publication fails if the destination exists, unlike rename on
    // Unix. Both names live in the same recovery directory/filesystem.
    fs::hard_link(partial, final_path).map_err(|_| "backup_publish_failed")?;
    fs::remove_file(partial).map_err(|_| "backup_publish_failed")?;
    #[cfg(unix)]
    File::open(final_path.parent().ok_or("backup_directory_failed")?)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "backup_sync_failed")?;
    Ok(MigrationRecoveryPointReceipt {
        path: final_path.to_path_buf(),
        size_bytes: size,
        sha256: format!("{:x}", digest.finalize()),
        includes_migration_journal: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_connection_uses_parsed_environment_and_query_overrides() {
        let values: std::collections::HashMap<_, _> = backup_connection_env(
            "postgresql://alice:p%40ss@localhost:5555/old?dbname=fixture&password=new%20pass&sslmode=require"
        ).unwrap().into_iter().collect();
        assert_eq!(values["PGDATABASE"], "fixture");
        assert_eq!(values["PGPASSWORD"], "new pass");
        assert_eq!(values["PGPORT"], "5555");
        assert_eq!(values["PGSSLMODE"], "require");
    }
    #[test]
    fn explicit_apply_and_pinned_source_are_required() {
        let temp = tempfile::tempdir().unwrap();
        let valid = serde_json::json!({"schema":SCHEMA,"protocolVersion":1,"allowApply":true,"migrationsDir":temp.path().join("migrations"),"expectedFingerprint":"a".repeat(64),"recoveryDirectory":temp.path().join("recovery"),"pgDumpBinary":temp.path().join("pg_dump")});
        assert!(parse(valid.to_string().as_bytes()).is_ok());
        for (field, value) in [
            ("allowApply", serde_json::json!(false)),
            ("expectedFingerprint", serde_json::json!("")),
            ("migrationsDir", serde_json::json!("/tmp/../data")),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(parse(invalid.to_string().as_bytes()).is_err());
        }
    }
    #[test]
    fn recovery_publication_never_overwrites_existing_backup() {
        let temp = tempfile::tempdir().unwrap();
        let partial = temp.path().join("backup.partial");
        let target = temp.path().join("backup.sql");
        fs::write(&partial, "new backup").unwrap();
        fs::write(&target, "existing backup").unwrap();
        assert!(finish_backup(&partial, &target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "existing backup");
        assert!(partial.exists());
    }
}
