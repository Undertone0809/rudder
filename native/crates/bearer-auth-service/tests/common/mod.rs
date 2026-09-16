#[allow(dead_code)]
#[path = "../../../d1-persistence/tests/support/mod.rs"]
mod database;
pub use database::*;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rudder_agent_key_service::{AgentKeyStore, BoardGrant, IssuedKey};
use rudder_bearer_auth_service::{BearerAuthenticator, JwtConfig};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

pub const USER: &str = "synthetic-board";
pub const SECRET: &str = "synthetic-bearer-parity-fixture-only-not-a-production-key";
pub const RUN: &str = "60000000-0000-4000-8000-000000000001";

pub fn auth(db: &Database) -> BearerAuthenticator {
    BearerAuthenticator::new(
        db.pool.clone(),
        Some(JwtConfig::new(SECRET.as_bytes(), "rudder", "rudder-api").unwrap()),
    )
}
pub async fn agent_key(db: &Database) -> IssuedKey {
    AgentKeyStore::new(db.pool.clone())
        .create(
            &BoardGrant::after_authorization(ORG, USER).unwrap(),
            CEO,
            "synthetic",
        )
        .await
        .unwrap()
}
pub async fn board_key(db: &Database, token: &str) -> String {
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Synthetic','synthetic@example.invalid',now(),now())")
        .bind(USER).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')")
        .bind(ORG).bind(USER).execute(&db.pool).await.unwrap();
    sqlx::query_scalar("INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'synthetic',$2) RETURNING id::text")
        .bind(USER).bind(format!("{:x}",Sha256::digest(token.as_bytes()))).fetch_one(&db.pool).await.unwrap()
}
pub fn claims() -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    json!({"sub":CEO,"org_id":ORG,"adapter_type":"codex_local","run_id":RUN,"iat":now,"exp":now+3600,"iss":"rudder","aud":"rudder-api"})
}
pub fn sign(header: Value, body: Value) -> String {
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(body.to_string())
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(input.as_bytes());
    format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

/// Execute the real existing Node signer, not a second Rust copy of it.
pub fn node_token() -> String {
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../server/src/agent-auth-jwt.ts");
    let code = "import {pathToFileURL} from 'node:url'; const {createLocalAgentJwt}=await import(pathToFileURL(process.argv[1]).href); process.stdout.write(createLocalAgentJwt(process.argv[2],process.argv[3],'codex_local',process.argv[4]));";
    let output = Command::new("node")
        .args([
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            code,
        ])
        .arg(source)
        .args([CEO, ORG, RUN])
        .env("RUDDER_AGENT_JWT_SECRET", SECRET)
        .env("RUDDER_AGENT_JWT_ISSUER", "rudder")
        .env("RUDDER_AGENT_JWT_AUDIENCE", "rudder-api")
        .env("RUDDER_AGENT_JWT_TTL_SECONDS", "3600")
        .output()
        .expect("Node must be present for signer parity");
    assert!(
        output.status.success(),
        "Node signer fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
pub async fn wait_for_lock(db: &Database, query: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(10),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1)")
                .bind(query).fetch_one(&db.pool).await.unwrap();
            if waiting {break;}
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.unwrap();
}
// End of disposable authentication fixtures.
