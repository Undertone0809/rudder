use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{env, fs, net::TcpListener, path::PathBuf, process::Command};
use tempfile::TempDir;

pub const ORG: &str = "10000000-0000-4000-8000-000000000001";
pub const OTHER: &str = "10000000-0000-4000-8000-000000000002";
pub const PROJECT: &str = "20000000-0000-4000-8000-000000000001";
pub const FOREIGN_PROJECT: &str = "20000000-0000-4000-8000-000000000002";
pub const GOAL: &str = "30000000-0000-4000-8000-000000000001";
pub const GOAL_TWO: &str = "30000000-0000-4000-8000-000000000002";
pub const FOREIGN_GOAL: &str = "30000000-0000-4000-8000-000000000003";
pub const ASSET: &str = "40000000-0000-4000-8000-000000000001";
pub const FOREIGN_ASSET: &str = "40000000-0000-4000-8000-000000000002";
pub const CEO: &str = "50000000-0000-4000-8000-000000000001";

pub struct Database {
    pub pool: PgPool,
    pg_ctl: PathBuf,
    root: TempDir,
}

impl Database {
    pub async fn start() -> Self {
        let root = tempfile::tempdir().expect("create disposable PostgreSQL directory");
        let data = root.path().join("data");
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("reserve disposable PostgreSQL port")
            .local_addr()
            .expect("read disposable PostgreSQL port")
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
        let dynamic_shared_memory_type = if cfg!(windows) { "windows" } else { "mmap" };
        let output = Command::new(&pg_ctl)
            .env("LC_ALL", "C")
            .arg("-D")
            .arg(&data)
            .arg("-l")
            .arg(root.path().join("postgres.log"))
            .arg("-o")
            .arg(format!(
                "-h 127.0.0.1 -p {port} -k {} -c shared_buffers=16MB -c max_connections=16 \
                 -c dynamic_shared_memory_type={dynamic_shared_memory_type}",
                root.path().display()
            ))
            .args(["-w", "start"])
            .output()
            .expect("run disposable PostgreSQL startup command");
        let log = fs::read_to_string(root.path().join("postgres.log"))
            .unwrap_or_else(|error| format!("<unavailable: {error}>"));
        assert!(
            output.status.success(),
            "disposable PostgreSQL failed: {}\npostgres log:\n{log}",
            String::from_utf8_lossy(&output.stderr)
        );
        let url = format!("postgresql://postgres@127.0.0.1:{port}/postgres");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(&url)
            .await
            .expect("connect disposable PostgreSQL");
        let database = Self { pool, pg_ctl, root };
        database.apply_migrations().await;
        database.seed().await;
        database
    }

    async fn apply_migrations(&self) {
        let migrations =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/db/src/migrations");
        let journal: serde_json::Value = serde_json::from_slice(
            &fs::read(migrations.join("meta/_journal.json")).expect("read migration journal"),
        )
        .expect("parse migration journal");
        for entry in journal["entries"].as_array().expect("migration entries") {
            let name = format!("{}.sql", entry["tag"].as_str().expect("migration tag"));
            let sql = fs::read_to_string(migrations.join(&name)).expect("read migration SQL");
            let mut tx = self
                .pool
                .begin()
                .await
                .expect("begin migration transaction");
            sqlx::raw_sql(&sql)
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|error| panic!("migration {name} failed: {error}"));
            tx.commit().await.expect("commit migration transaction");
        }
    }

    async fn seed(&self) {
        for (organization_id, suffix) in [(ORG, "A"), (OTHER, "B")] {
            sqlx::query(
                "INSERT INTO organizations (id, url_key, name, issue_prefix)
                 VALUES ($1::uuid, $2, 'Original', $2)",
            )
            .bind(organization_id)
            .bind(suffix)
            .execute(&self.pool)
            .await
            .expect("seed organization");
            sqlx::query(
                "INSERT INTO organization_mutation_state (org_id, owner, fence_epoch)
                 VALUES ($1::uuid, 'rust', 7)",
            )
            .bind(organization_id)
            .execute(&self.pool)
            .await
            .expect("seed mutation state");
        }
        for (goal_id, organization_id) in [(GOAL, ORG), (GOAL_TWO, ORG), (FOREIGN_GOAL, OTHER)] {
            sqlx::query(
                "INSERT INTO goals (id, org_id, title)
                 VALUES ($1::uuid, $2::uuid, 'Synthetic goal')",
            )
            .bind(goal_id)
            .bind(organization_id)
            .execute(&self.pool)
            .await
            .expect("seed goal");
        }
        for (project_id, organization_id) in [(PROJECT, ORG), (FOREIGN_PROJECT, OTHER)] {
            sqlx::query(
                "INSERT INTO projects (id, org_id, name)
                 VALUES ($1::uuid, $2::uuid, 'Synthetic project')",
            )
            .bind(project_id)
            .bind(organization_id)
            .execute(&self.pool)
            .await
            .expect("seed project");
        }
        for (asset_id, organization_id) in [(ASSET, ORG), (FOREIGN_ASSET, OTHER)] {
            sqlx::query(
                "INSERT INTO assets
                  (id, org_id, provider, object_key, content_type, byte_size, sha256)
                 VALUES ($1::uuid, $2::uuid, 'local', 'synthetic', 'image/png', 1, 'synthetic')",
            )
            .bind(asset_id)
            .bind(organization_id)
            .execute(&self.pool)
            .await
            .expect("seed asset");
        }
        sqlx::query(
            "INSERT INTO agents (id, org_id, name, role, status)
             VALUES ($1::uuid, $2::uuid, 'Synthetic CEO', 'ceo', 'idle')",
        )
        .bind(CEO)
        .bind(ORG)
        .execute(&self.pool)
        .await
        .expect("seed CEO agent");
    }

    pub async fn counts(&self) -> (i64, i64, i64) {
        sqlx::query_as(
            "SELECT
               (SELECT mutation_version FROM organization_mutation_state WHERE org_id=$1::uuid),
               (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid),
               (SELECT count(*) FROM organization_mutation_receipts WHERE org_id=$1::uuid)",
        )
        .bind(ORG)
        .fetch_one(&self.pool)
        .await
        .expect("read mutation counts")
    }

    pub async fn name(&self) -> String {
        sqlx::query_scalar("SELECT name FROM organizations WHERE id=$1::uuid")
            .bind(ORG)
            .fetch_one(&self.pool)
            .await
            .expect("read organization name")
    }

    pub async fn sql(&self, sql: &str) {
        sqlx::raw_sql(sql)
            .execute(&self.pool)
            .await
            .expect("execute test SQL");
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
        paths.extend(env::split_paths(&path).map(|directory| directory.join(&executable)));
    }
    if let Ok(versions) = fs::read_dir("/usr/lib/postgresql") {
        paths.extend(
            versions
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(&executable)),
        );
    }
    paths
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("missing PostgreSQL {name}"))
}

fn checked(command: &mut Command) {
    let output = command.output().expect("run disposable PostgreSQL command");
    assert!(
        output.status.success(),
        "disposable PostgreSQL failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
