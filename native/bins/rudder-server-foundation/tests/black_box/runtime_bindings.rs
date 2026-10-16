//! Real Rust process + migrated disposable PostgreSQL, with no Node process.
use super::*;
use serde_json::json;

const ORG: &str = "10000000-0000-4000-8000-000000000001";
const OTHER: &str = "10000000-0000-4000-8000-000000000002";
const AGENT: &str = "20000000-0000-4000-8000-000000000001";
const CHAT: &str = "30000000-0000-4000-8000-000000000001";
const SECRET: &str = "synthetic-native-binding-black-box-key";

struct ServerGuard(Option<(Child, BufReader<ChildStdout>)>);
impl ServerGuard {
    fn start(overrides: &[(&str, &str)]) -> (Self, SocketAddr) {
        let (child, stdout, addr) = spawn_server(overrides);
        (Self(Some((child, stdout))), addr)
    }
    fn stop(mut self) {
        let (child, stdout) = self.0.take().unwrap();
        stop_server(child, stdout);
    }
}
impl Drop for ServerGuard {
    fn drop(&mut self) {
        if let Some((child, _)) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn call(addr: SocketAddr, org: &str, nonce: &str, input: &Value) -> (u16, Value) {
    call_authority(addr, org, nonce, "binding", input)
}

fn call_authority(
    addr: SocketAddr,
    org: &str,
    nonce: &str,
    authority: &str,
    input: &Value,
) -> (u16, Value) {
    let path = format!("/internal/orgs/{org}/runtime-{authority}s");
    let body = serde_json::to_vec(input).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let envelope = ActorEnvelope::new(
        ActorIdentity::new("user", "local-board").unwrap(),
        org,
        "local-implicit",
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        "POST",
        &path,
        format!(
            "runtime.{authority}.{}",
            input["operation"].as_str().unwrap()
        ),
        &body,
        nonce,
        nonce,
        now,
        now + 60,
    )
    .unwrap()
    .sign(SECRET.as_bytes())
    .unwrap();
    let signed = serde_json::to_string(&envelope).unwrap();
    let raw = http_request_with_body(
        addr,
        "POST",
        &path,
        &[
            (ACTOR_ENVELOPE_HEADER, &signed),
            (ACTOR_ENVELOPE_REQUEST_ID_HEADER, nonce),
            ("content-type", "application/json"),
        ],
        &body,
    )
    .unwrap();
    let (headers, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap())
}

async fn migrate(pool: &sqlx::PgPool) {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/db/src/migrations");
    let journal: Value =
        serde_json::from_slice(&fs::read(root.join("meta/_journal.json")).unwrap()).unwrap();
    for entry in journal["entries"].as_array().unwrap() {
        let sql = fs::read_to_string(root.join(format!("{}.sql", entry["tag"].as_str().unwrap())))
            .unwrap();
        sqlx::raw_sql(&sql).execute(pool).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn native_binding_roundtrip_survives_restart_and_conflicts_do_not_mutate() {
    let postgres = PostgresHarness::start();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&postgres.url)
        .await
        .unwrap();
    migrate(&pool).await;
    for (id, key) in [(ORG, "NB1"), (OTHER, "NB2")] {
        sqlx::query("INSERT INTO organizations(id,url_key,name,issue_prefix) VALUES($1::uuid,$2,'Binding fixture',$2)")
            .bind(id).bind(key).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO agents(id,org_id,name,agent_runtime_type) VALUES($1::uuid,$2::uuid,'Binding agent','codex_local')")
        .bind(AGENT).bind(ORG).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO chat_conversations(id,org_id,preferred_agent_id,created_by_user_id) VALUES($1::uuid,$2::uuid,$3::uuid,'local-board')")
        .bind(CHAT).bind(ORG).bind(AGENT).execute(&pool).await.unwrap();
    let overrides = [
        ("RUDDER_NATIVE_DATABASE_URL", postgres.url.as_str()),
        ("RUDDER_NATIVE_DATABASE_REQUIRED", "true"),
        ("RUDDER_NATIVE_ACTOR_ENVELOPE_KEY", SECRET),
    ];
    let (server, addr) = ServerGuard::start(&overrides);
    let target = json!({"targetType":"chat_conversation","targetId":CHAT});
    let ensure = json!({"operation":"ensure","target":target,"identity":{"agentId":AGENT}});
    let (status, first) = call(addr, ORG, "binding-first", &ensure);
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["binding"]["runtimeType"], "codex_local");
    assert_eq!(first["segment"]["state"], "pending");
    let (status, duplicate) = call(addr, ORG, "binding-duplicate", &ensure);
    assert_eq!(status, 200, "{duplicate}");
    assert_eq!(first, duplicate);
    let mut conflict = ensure.clone();
    conflict["identity"]["profileId"] = json!("changed-profile");
    assert_eq!(call(addr, ORG, "binding-conflict", &conflict).0, 409);
    assert_eq!(call(addr, OTHER, "binding-foreign", &ensure).0, 404);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM runtime_bindings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let segments: i64 = sqlx::query_scalar("SELECT count(*) FROM native_segments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(segments, 1);
    server.stop();
    let (server, addr) = ServerGuard::start(&overrides);
    let (status, restored) = call(
        addr,
        ORG,
        "binding-after-restart",
        &json!({"operation":"current","target":target}),
    );
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored, first);
    let (status, read) = call(
        addr,
        ORG,
        "binding-read",
        &json!({"operation":"read","bindingId":first["binding"]["id"]}),
    );
    assert_eq!(status, 200, "{read}");
    assert_eq!(read, first);
    server.stop();
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn native_span_fences_locator_writes_and_reads_exact_locator_after_restart() {
    const RUN: &str = "40000000-0000-4000-8000-000000000001";
    const ATTEMPT: &str = "50000000-0000-4000-8000-000000000001";
    let postgres = PostgresHarness::start();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&postgres.url)
        .await
        .unwrap();
    migrate(&pool).await;
    sqlx::query("INSERT INTO organizations(id,url_key,name,issue_prefix) VALUES($1::uuid,'SPN','Span fixture','SPN')")
        .bind(ORG).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO agents(id,org_id,name,agent_runtime_type) VALUES($1::uuid,$2::uuid,'Span agent','codex_local')")
        .bind(AGENT).bind(ORG).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO chat_conversations(id,org_id,preferred_agent_id,created_by_user_id) VALUES($1::uuid,$2::uuid,$3::uuid,'local-board')")
        .bind(CHAT).bind(ORG).bind(AGENT).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,chat_conversation_id,invocation_source,status,execution_owner_token,execution_lease_expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'chat','running','fixture-owner',clock_timestamp()+interval '5 minutes')")
        .bind(RUN).bind(ORG).bind(AGENT).bind(CHAT).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO heartbeat_run_attempts(id,org_id,run_id,agent_id,attempt_index,runtime_type,status,owner_token,attempt_epoch) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,0,'codex_local','started','fixture-owner',1)")
        .bind(ATTEMPT).bind(ORG).bind(RUN).bind(AGENT).execute(&pool).await.unwrap();
    let overrides = [
        ("RUDDER_NATIVE_DATABASE_URL", postgres.url.as_str()),
        ("RUDDER_NATIVE_DATABASE_REQUIRED", "true"),
        ("RUDDER_NATIVE_ACTOR_ENVELOPE_KEY", SECRET),
    ];
    let (server, addr) = ServerGuard::start(&overrides);
    let (status, binding) = call(
        addr,
        ORG,
        "span-binding",
        &json!({"operation":"ensure","target":{"targetType":"chat_conversation","targetId":CHAT},"identity":{"agentId":AGENT}}),
    );
    assert_eq!(status, 200, "{binding}");
    let open = json!({"operation":"open","runId":RUN,"attemptId":ATTEMPT,"attemptEpoch":1,"ownerToken":"fixture-owner","bindingId":binding["binding"]["id"],"segmentId":binding["segment"]["id"]});
    let (status, span) = call_authority(addr, ORG, "span-open", "span", &open);
    assert_eq!(status, 200, "{span}");
    assert!(span["span"].get("ownerToken").is_none());
    assert_eq!(
        call_authority(addr, ORG, "span-open-repeat", "span", &open),
        (200, span.clone())
    );
    let locator = json!({"operation":"bind_locator","spanId":span["span"]["id"],"attemptId":ATTEMPT,"attemptEpoch":1,"ownerToken":"fixture-owner","nativeSessionId":"  native opaque 雪  ","rootSessionId":" root ","leafId":" leaf "});
    let (status, bound) = call_authority(addr, ORG, "span-locator", "span", &locator);
    assert_eq!(status, 200, "{bound}");
    assert_eq!(bound["segment"]["nativeSessionId"], "  native opaque 雪  ");
    assert_eq!(
        call_authority(addr, ORG, "span-locator-repeat", "span", &locator),
        (200, bound.clone())
    );
    let mut conflict = locator.clone();
    conflict["nativeSessionId"] = json!("different-session");
    assert_eq!(
        call_authority(addr, ORG, "span-locator-conflict", "span", &conflict).0,
        409
    );
    let mut stale = locator.clone();
    stale["ownerToken"] = json!("late-old-owner");
    assert_eq!(
        call_authority(addr, ORG, "span-stale-owner", "span", &stale).0,
        409
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM run_runtime_spans")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    // Lease expiry bars another write but never prevents authorized history.
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid")
        .bind(RUN).execute(&pool).await.unwrap();
    assert_eq!(
        call_authority(addr, ORG, "span-expired-owner", "span", &locator).0,
        409
    );
    server.stop();
    let (server, addr) = ServerGuard::start(&overrides);
    let (status, restored) = call_authority(
        addr,
        ORG,
        "span-after-restart",
        "span",
        &json!({"operation":"read","spanId":span["span"]["id"]}),
    );
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored, bound);
    server.stop();
    pool.close().await;
}
