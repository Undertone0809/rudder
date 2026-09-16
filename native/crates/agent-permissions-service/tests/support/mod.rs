#![allow(dead_code)]
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{env, fs, net::TcpListener, path::PathBuf, process::Command};
use tempfile::TempDir;

pub const ORG: &str = "10000000-0000-4000-8000-000000000001";
pub const OTHER: &str = "10000000-0000-4000-8000-000000000002";
pub const CEO: &str = "50000000-0000-4000-8000-000000000001";
pub const TARGET: &str = "50000000-0000-4000-8000-000000000002";
pub const FOREIGN: &str = "50000000-0000-4000-8000-000000000003";

pub struct Database {
    pub pool: PgPool,
    pg_ctl: PathBuf,
    root: TempDir,
}

impl Database {
    pub async fn start() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
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
                .arg(format!("-h 127.0.0.1 -p {port} -F"))
                .args(["-w", "start"]),
        );
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(&format!("postgresql://postgres@127.0.0.1:{port}/postgres"))
            .await
            .unwrap();
        let db = Self { pool, pg_ctl, root };
        db.migrate().await;
        db.seed().await;
        db
    }

    async fn migrate(&self) {
        let migrations =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/db/src/migrations");
        let journal: serde_json::Value =
            serde_json::from_slice(&fs::read(migrations.join("meta/_journal.json")).unwrap())
                .unwrap();
        for entry in journal["entries"].as_array().unwrap() {
            let name = format!("{}.sql", entry["tag"].as_str().unwrap());
            let mut tx = self.pool.begin().await.unwrap();
            sqlx::raw_sql(&fs::read_to_string(migrations.join(&name)).unwrap())
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|error| panic!("migration {name}: {error}"));
            tx.commit().await.unwrap();
        }
    }

    async fn seed(&self) {
        for (org, key) in [(ORG, "A"), (OTHER, "B")] {
            sqlx::query(
                "INSERT INTO organizations (id,url_key,name,issue_prefix) VALUES ($1::uuid,$2,'Test',$2)",
            )
            .bind(org)
            .bind(key)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        for (id, org, role, name) in [
            (CEO, ORG, "ceo", "CEO"),
            (TARGET, ORG, "engineer", "Target"),
            (FOREIGN, OTHER, "engineer", "Foreign"),
        ] {
            sqlx::query(
                "INSERT INTO agents (id,org_id,name,role) VALUES ($1::uuid,$2::uuid,$3,$4)",
            )
            .bind(id)
            .bind(org)
            .bind(name)
            .bind(role)
            .execute(&self.pool)
            .await
            .unwrap();
        }
    }

    pub async fn permissions(&self, id: &str) -> serde_json::Value {
        sqlx::query_scalar("SELECT permissions FROM agents WHERE id=$1::uuid")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    pub async fn grant_count(&self, id: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM principal_permission_grants WHERE principal_id=$1")
            .bind(id.to_string())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    pub async fn activity_count(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM activity_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        let _ = Command::new(&self.pg_ctl)
            .env("LC_ALL", "C")
            .arg("-D")
            .arg(self.root.path().join("data"))
            .args(["-m", "immediate", "-w", "stop"])
            .output();
    }
}

fn binary(name: &str) -> PathBuf {
    let executable = format!("{name}{}", env::consts::EXE_SUFFIX);
    let mut paths = Vec::new();
    if let Some(dir) = env::var_os("RUDDER_POSTGRES_BIN_DIR") {
        paths.push(PathBuf::from(dir).join(&executable));
    }
    if let Some(path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&path).map(|path| path.join(&executable)));
    }
    if let Ok(versions) = fs::read_dir("/usr/lib/postgresql") {
        paths.extend(
            versions
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(&executable)),
        );
    }
    let pnpm = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../node_modules/.pnpm");
    if let Ok(packages) = fs::read_dir(pnpm) {
        paths.extend(packages.filter_map(Result::ok).filter_map(|entry| {
            let name = entry.file_name();
            name.to_string_lossy()
                .starts_with("@embedded-postgres+")
                .then(|| {
                    entry
                        .path()
                        .join("node_modules/@embedded-postgres/linux-x64/native/bin")
                        .join(&executable)
                })
        }));
    }
    paths
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("missing PostgreSQL {name}"))
}

fn checked(command: &mut Command) {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "disposable PostgreSQL failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
