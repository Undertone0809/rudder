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
    pub url: String,
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
        let socket = if cfg!(unix) {
            format!(" -k {}", root.path().display())
        } else {
            String::new()
        };
        checked(
            Command::new(&pg_ctl)
                .env("LC_ALL", "C")
                .arg("-D")
                .arg(&data)
                .arg("-l")
                .arg(root.path().join("postgres.log"))
                .arg("-o")
                .arg(format!("-h 127.0.0.1 -p {port} -F{socket}"))
                .args(["-w", "start"]),
        );
        let url = format!("postgresql://postgres@127.0.0.1:{port}/postgres");
        let pool = PgPoolOptions::new()
            .max_connections(6)
            .connect(&url)
            .await
            .unwrap();
        let db = Self {
            pool,
            url,
            pg_ctl,
            root,
        };
        let migrations =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/db/src/migrations");
        let journal: serde_json::Value =
            serde_json::from_slice(&fs::read(migrations.join("meta/_journal.json")).unwrap())
                .unwrap();
        for entry in journal["entries"].as_array().unwrap() {
            let name = format!("{}.sql", entry["tag"].as_str().unwrap());
            let mut tx = db.pool.begin().await.unwrap();
            sqlx::raw_sql(&fs::read_to_string(migrations.join(&name)).unwrap())
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|error| panic!("migration {name}: {error}"));
            tx.commit().await.unwrap();
        }
        db.seed().await;
        db
    }
    pub async fn restart(&mut self) {
        self.pool.close().await;
        checked(
            Command::new(&self.pg_ctl)
                .env("LC_ALL", "C")
                .arg("-D")
                .arg(self.root.path().join("data"))
                .arg("-l")
                .arg(self.root.path().join("postgres.log"))
                .args(["-m", "fast", "-w", "restart"]),
        );
        self.pool = PgPoolOptions::new()
            .max_connections(6)
            .connect(&self.url)
            .await
            .unwrap();
    }
    async fn seed(&self) {
        for (org, suffix) in [(ORG, "A"), (OTHER, "B")] {
            sqlx::query("INSERT INTO organizations (id,url_key,name,issue_prefix) VALUES ($1::uuid,$2,'Original',$2)")
                .bind(org).bind(suffix).execute(&self.pool).await.unwrap();
            // Test setup only; no public ownership-acquisition implementation exists.
            sqlx::query("INSERT INTO organization_mutation_state (org_id,owner,fence_epoch) VALUES ($1::uuid,'rust',7)")
                .bind(org).execute(&self.pool).await.unwrap();
        }
        for (goal, org) in [(GOAL, ORG), (GOAL_TWO, ORG), (FOREIGN_GOAL, OTHER)] {
            sqlx::query(
                "INSERT INTO goals (id,org_id,title) VALUES ($1::uuid,$2::uuid,'Synthetic goal')",
            )
            .bind(goal)
            .bind(org)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        for (project, org) in [(PROJECT, ORG), (FOREIGN_PROJECT, OTHER)] {
            sqlx::query("INSERT INTO projects (id,org_id,name) VALUES ($1::uuid,$2::uuid,'Synthetic project')")
                .bind(project).bind(org).execute(&self.pool).await.unwrap();
        }
        for (asset, org) in [(ASSET, ORG), (FOREIGN_ASSET, OTHER)] {
            sqlx::query("INSERT INTO assets (id,org_id,provider,object_key,content_type,byte_size,sha256) VALUES ($1::uuid,$2::uuid,'local','synthetic','image/png',1,'synthetic')")
                .bind(asset).bind(org).execute(&self.pool).await.unwrap();
        }
        sqlx::query("INSERT INTO agents (id,org_id,name,role) VALUES ($1::uuid,$2::uuid,'Synthetic CEO','ceo')")
            .bind(CEO).bind(ORG).execute(&self.pool).await.unwrap();
    }
    pub async fn counts(&self) -> (i64, i64, i64) {
        sqlx::query_as("SELECT (SELECT mutation_version FROM organization_mutation_state WHERE org_id=$1::uuid), (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid), (SELECT count(*) FROM organization_mutation_receipts WHERE org_id=$1::uuid)")
            .bind(ORG).fetch_one(&self.pool).await.unwrap()
    }
    pub async fn name(&self) -> String {
        sqlx::query_scalar("SELECT name FROM organizations WHERE id=$1::uuid")
            .bind(ORG)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
    pub async fn sql(&self, sql: &str) {
        sqlx::raw_sql(sql).execute(&self.pool).await.unwrap();
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
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "disposable PostgreSQL failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
