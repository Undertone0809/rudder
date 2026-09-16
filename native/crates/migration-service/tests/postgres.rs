use rudder_migration_core::{MigrationLimits, load_migration_manifest};
use rudder_migration_service::{
    MigrationService, MigrationState, NODE_ADVISORY_LOCK_NAME, recovery_binding,
};
use sqlx::{Connection, PgConnection};
use std::{env, fs, net::TcpListener, path::PathBuf, process::Command, time::Duration};
use tempfile::TempDir;

struct Database {
    url: String,
    pg_ctl: PathBuf,
    root: TempDir,
}
impl Database {
    async fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        if is_root() {
            let status = Command::new("chown")
                .args(["ubuntu:ubuntu", root.path().to_str().unwrap()])
                .status()
                .unwrap();
            assert!(
                status.success(),
                "failed to prepare the disposable PostgreSQL root"
            );
        }
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        checked(
            Command::new(binary("initdb"))
                .env("LC_ALL", "C")
                .arg("-D")
                .arg(&data)
                .args([
                    "--encoding=UTF8",
                    "--locale=C",
                    "--auth=trust",
                    "--username=postgres",
                    "--no-sync",
                ]),
        );
        let pg_ctl = binary("pg_ctl");
        checked(
            Command::new(&pg_ctl)
                .env("LC_ALL", "C")
                .arg("-D")
                .arg(&data)
                .arg("-l")
                .arg(root.path().join("postgres.log"))
                .arg("-o")
                .arg(format!(
                    "-h 127.0.0.1 -p {port} -F -k {}",
                    root.path().display()
                ))
                .args(["-w", "start"]),
        );
        Self {
            url: format!("postgresql://postgres@127.0.0.1:{port}/postgres"),
            pg_ctl,
            root,
        }
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = output(
            Command::new(&self.pg_ctl)
                .env("LC_ALL", "C")
                .arg("-D")
                .arg(self.root.path().join("data"))
                .args(["-m", "immediate", "-w", "stop"]),
        );
    }
}
fn binary(name: &str) -> PathBuf {
    let executable = format!("{name}{}", env::consts::EXE_SUFFIX);
    let mut paths = Vec::new();
    if let Some(dir) = env::var_os("RUDDER_POSTGRES_BIN_DIR") {
        paths.push(PathBuf::from(dir).join(&executable));
    }
    if let Some(path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&path).map(|p| p.join(&executable)));
    }
    if let Ok(versions) = fs::read_dir("/usr/lib/postgresql") {
        paths.extend(
            versions
                .filter_map(Result::ok)
                .map(|p| p.path().join("bin").join(&executable)),
        );
    }
    paths
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("missing PostgreSQL {name}"))
}
fn checked(command: &mut Command) {
    let output = output(command).unwrap();
    assert!(
        output.status.success(),
        "disposable PostgreSQL failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn output(command: &mut Command) -> std::io::Result<std::process::Output> {
    if is_root() {
        let mut unprivileged = Command::new("runuser");
        unprivileged.args(["-u", "ubuntu", "--"]);
        unprivileged.arg(command.get_program());
        unprivileged.args(command.get_args());
        for (key, value) in command.get_envs() {
            if let Some(value) = value {
                unprivileged.env(key, value);
            }
        }
        unprivileged.output()
    } else {
        command.output()
    }
}
fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|output| output.stdout == b"0\n")
}
fn assets() -> (PathBuf, rudder_migration_core::MigrationManifest) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/db/src/migrations");
    let manifest = load_migration_manifest(
        &dir.join("meta/_journal.json"),
        &dir,
        MigrationLimits::default(),
    )
    .unwrap();
    (dir, manifest)
}

#[tokio::test]
async fn canonical_rust_run_is_visible_as_current_to_node_and_survives_restart() {
    let db = Database::start().await;
    let (dir, manifest) = assets();
    let service = MigrationService::new(&dir, manifest.clone()).unwrap();
    let report = service.run(&db.url, None).await.unwrap();
    assert_eq!(report.applied.len(), manifest.entries.len());
    assert!(matches!(report.after, MigrationState::Current { .. }));
    assert!(service.run(&db.url, None).await.unwrap().applied.is_empty());
    checked(
        Command::new(&db.pg_ctl)
            .env("LC_ALL", "C")
            .arg("-D")
            .arg(db.root.path().join("data"))
            .arg("-l")
            .arg(db.root.path().join("postgres.log"))
            .args(["-m", "fast", "-w", "restart"]),
    );
    assert!(matches!(
        service.connect_and_preflight(&db.url).await.unwrap(),
        MigrationState::Current { .. }
    ));
    let binding = recovery_binding(&db.url, &manifest, &db.root.path().join("backup.dump"))
        .await
        .unwrap();
    assert_eq!(binding.manifest_fingerprint, manifest.fingerprint);
    assert!(binding.includes_migration_journal);
}

#[tokio::test]
async fn cancelled_waiter_releases_its_connection_and_node_lock_protocol_remains_usable() {
    let db = Database::start().await;
    let (dir, manifest) = assets();
    let service = MigrationService::new(dir, manifest).unwrap();
    let mut blocker = PgConnection::connect(&db.url).await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(hashtext(current_database()),hashtext($1))")
        .bind(NODE_ADVISORY_LOCK_NAME)
        .execute(&mut blocker)
        .await
        .unwrap();
    let url = db.url.clone();
    let task = tokio::spawn(async move { service.run(&url, None).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    drop(blocker);
    let mut probe = PgConnection::connect(&db.url).await.unwrap();
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_lock(hashtext(current_database()),hashtext($1))",
    )
    .bind(NODE_ADVISORY_LOCK_NAME)
    .fetch_one(&mut probe)
    .await
    .unwrap();
    assert!(acquired);
}
