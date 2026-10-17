//! Real HTTP admission/control/replay checks over disposable PostgreSQL.
//! Worker cases launch the owned synthetic provider fixture; they do not call
//! an installed provider or establish real-Profile/runtime acceptance.

use super::*;
use actix_web::http::{Method, StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::sync::Arc;

use crate::native_chat_test_fixture as fixture;
use rudder_d1_persistence::native_chat as persistence_chat;

const SESSION_SECRET: &[u8] = b"native-chat-public-control-http-session-secret";
const AUTH_ENVELOPE_KEY: &[u8] = b"native-chat-public-control-http-envelope-key";
const ALLOWED_ORIGIN: &str = "http://localhost";
const PRIVATE_THREAD: &str = "private-provider-thread-canary";
const PRIVATE_OWNER: &str = "private-owner-token-canary";
const FOREIGN_CHAT: &str = "31000000-0000-4000-8000-000000000001";
const FOREIGN_AGENT: &str = "51000000-0000-4000-8000-000000000002";
const FOREIGN_MESSAGE: &str = "41000000-0000-4000-8000-000000000002";
const FOREIGN_GENERATION: &str = "61000000-0000-4000-8000-000000000002";
const FOREIGN_RUN: &str = "71000000-0000-4000-8000-000000000002";
const SEND_CHAT: &str = "21000000-0000-4000-8000-000000000401";

fn signed_session_cookie(token: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(SESSION_SECRET).unwrap();
    mac.update(token.as_bytes());
    let signed = format!("{token}.{}", STANDARD.encode(mac.finalize().into_bytes()));
    let encoded =
        percent_encoding::utf8_percent_encode(&signed, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    format!("better-auth.session_token={encoded}")
}

async fn request(
    client: &awc::Client,
    method: Method,
    url: String,
    cookie: Option<&str>,
    origin: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = client.request(method, url);
    if let Some(cookie) = cookie {
        builder = builder.insert_header((header::COOKIE, cookie));
    }
    if let Some(origin) = origin {
        builder = builder.insert_header((header::ORIGIN, origin));
    }
    let mut response = match body {
        Some(body) => builder
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .send_body(serde_json::to_vec(&body).unwrap())
            .await
            .unwrap(),
        None => builder.send().await.unwrap(),
    };
    let status = response.status();
    let body = response.body().await.unwrap().to_vec();
    (status, body)
}

async fn chat_business_counts(pool: &sqlx::PgPool, conversation_id: &str) -> Vec<i64> {
    let row = sqlx::query(
        "SELECT
           (SELECT count(*) FROM chat_messages
             WHERE org_id=$1::uuid AND conversation_id=$2::uuid),
           (SELECT count(*) FROM chat_generations
             WHERE org_id=$1::uuid AND conversation_id=$2::uuid),
           (SELECT count(*) FROM heartbeat_runs
             WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid),
           (SELECT count(*) FROM heartbeat_run_attempts a
             JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
             WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid),
           (SELECT count(*) FROM chat_generation_events e
             JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
             WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid),
           (SELECT count(*) FROM chat_control_actions a
             JOIN chat_generations g ON g.org_id=a.org_id AND g.id=a.expected_generation_id
             WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid),
           (SELECT count(*) FROM cost_events c
             JOIN heartbeat_runs r ON r.org_id=c.org_id AND r.id=c.heartbeat_run_id
             WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid),
           (SELECT count(*) FROM activity_log l
             WHERE l.entity_type='chat_generation' AND l.entity_id IN
               (SELECT id::text FROM chat_generations
                 WHERE org_id=$1::uuid AND conversation_id=$2::uuid))",
    )
    .bind(fixture::ORG)
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .unwrap();
    (0..8).map(|index| row.try_get(index).unwrap()).collect()
}

#[derive(Debug, PartialEq)]
struct ControlState {
    event_count: i64,
    action_count: i64,
    checkpoint_seq: Option<i32>,
    checkpoint_hash: Option<String>,
    control_version: i32,
    generation_status: String,
    control_audit_count: i64,
}

async fn control_state(pool: &sqlx::PgPool, generation_id: &str) -> ControlState {
    let row = sqlx::query(
        "SELECT
           (SELECT count(*) FROM chat_generation_events WHERE generation_id=$1::uuid),
           (SELECT count(*) FROM chat_control_actions WHERE expected_generation_id=$1::uuid),
           last_client_checkpoint_seq,last_client_checkpoint_hash,control_version,status,
           (SELECT count(*) FROM activity_log WHERE entity_type='chat_generation'
             AND entity_id=$1 AND action IN ('runtime.native_chat.client_checkpoint',
               'runtime.native_chat.stop_requested'))
         FROM chat_generations WHERE id=$1::uuid",
    )
    .bind(generation_id)
    .fetch_one(pool)
    .await
    .unwrap();
    ControlState {
        event_count: row.try_get(0).unwrap(),
        action_count: row.try_get(1).unwrap(),
        checkpoint_seq: row.try_get(2).unwrap(),
        checkpoint_hash: row.try_get(3).unwrap(),
        control_version: row.try_get(4).unwrap(),
        generation_status: row.try_get(5).unwrap(),
        control_audit_count: row.try_get(6).unwrap(),
    }
}

async fn add_private_projection_canaries(pool: &sqlx::PgPool, generation_id: &str) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:test_http_projection',true)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE chat_generation_events SET payload=payload || $2::jsonb
         WHERE generation_id=$1::uuid AND generation_seq=1",
    )
    .bind(generation_id)
    .bind(
        serde_json::json!({
            "providerThreadId":PRIVATE_THREAD,
            "ownerToken":PRIVATE_OWNER,
        })
        .to_string(),
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn seed_foreign_native_target(pool: &sqlx::PgPool, user_id: &str) {
    // A fully persisted, held native generation and Run in OTHER. The caller
    // has no membership there, and this synthetic target never launches a
    // provider; it exercises the real organization-scoped HTTP guards.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:test_foreign_http_target',true)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role,status)
         VALUES($1::uuid,$2::uuid,'Native Chat HTTP foreign fixture','general','idle')",
    )
    .bind(FOREIGN_AGENT)
    .bind(fixture::support::OTHER)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chat_conversations(id,org_id,title,conversation_kind,created_by_user_id,status,preferred_agent_id)
         VALUES($1::uuid,$2::uuid,'Foreign native fixture','chat',$3,'active',$4::uuid)",
    )
    .bind(FOREIGN_CHAT)
    .bind(fixture::support::OTHER)
    .bind(user_id)
    .bind(FOREIGN_AGENT)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chat_messages(id,org_id,conversation_id,role,kind,status,body,turn_variant)
         VALUES($1::uuid,$2::uuid,$3::uuid,'user','message','completed','foreign synthetic input',0)",
    )
    .bind(FOREIGN_MESSAGE)
    .bind(fixture::support::OTHER)
    .bind(FOREIGN_CHAT)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chat_generations
           (id,org_id,conversation_id,execution_authority,source_message_id,source_turn_variant,
            native_admission_hold,status,attempt_epoch,control_state,control_runtime_type)
         VALUES($1::uuid,$2::uuid,$3::uuid,'native_rust',$4::uuid,0,true,'starting',1,'unregistered','codex_local')",
    )
    .bind(FOREIGN_GENERATION)
    .bind(fixture::support::OTHER)
    .bind(FOREIGN_CHAT)
    .bind(FOREIGN_MESSAGE)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO heartbeat_runs
           (id,org_id,agent_id,invocation_source,status,context_snapshot,
            chat_conversation_id,chat_generation_id,execution_authority,native_admission_hold,
            scene,target_type,target_id,idempotency_key,session_reuse_scope,session_intent_json)
         VALUES($1::uuid,$2::uuid,$3::uuid,'chat','running',$4::jsonb,
            $5::uuid,$6::uuid,'native_rust',true,'chat','chat_conversation',$5,
            'native-http-foreign-target','none',
            '{\"kind\":\"fresh\",\"reuseScope\":\"none\",\"sourceRunId\":null,\"sessionId\":null,\"sessionParams\":null}'::jsonb)",
    )
    .bind(FOREIGN_RUN)
    .bind(fixture::support::OTHER)
    .bind(FOREIGN_AGENT)
    .bind(serde_json::json!({"scene":"chat","targetType":"chat_conversation","targetId":FOREIGN_CHAT}).to_string())
    .bind(FOREIGN_CHAT)
    .bind(FOREIGN_GENERATION)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chat_generation_events
           (org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,run_id)
         VALUES($1::uuid,$2::uuid,1,1,'generation_started','{}'::jsonb,$3::uuid)",
    )
    .bind(fixture::support::OTHER)
    .bind(FOREIGN_GENERATION)
    .bind(FOREIGN_RUN)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn session_auth_state(pool: &sqlx::PgPool, session_id: &str) -> String {
    sqlx::query_scalar(
        "SELECT expires_at::text || '|' || updated_at::text FROM session WHERE id=$1",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[actix_web::test]
#[ignore = "requires PostgreSQL binaries; disposable database and synthetic admission only"]
async fn public_control_http_uses_real_auth_and_postgres_without_provider_dispatch() {
    let database = fixture::Database::start().await;
    let host = fixture::FixtureHost::new("complete");
    let (actor, run_id, _attempt_id) = fixture::admitted(&database, &host).await;
    let user_id = actor.actor().id.clone();
    let token = format!("native-public-control-session-{}", uuid::Uuid::new_v4());
    let session_id = format!("native-public-control-session-row-{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES($1,'Native Chat HTTP fixture',$2,now(),now()) ON CONFLICT(id) DO NOTHING",
    )
    .bind(&user_id)
    .bind(format!("{user_id}@native-chat.invalid"))
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now(),now())",
    )
    .bind(&session_id)
    .bind(&user_id)
    .bind(&token)
    .execute(&database.pool)
    .await
    .unwrap();

    let generation_id: String =
        sqlx::query_scalar("SELECT chat_generation_id::text FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&run_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    add_private_projection_canaries(&database.pool, &generation_id).await;

    let database_url = format!(
        "postgresql://postgres@127.0.0.1:{}/postgres",
        database.pool.connect_options().get_port()
    );
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url),
            actor_envelope_key: Some(rudder_auth_core::SigningKey::new(AUTH_ENVELOPE_KEY).unwrap()),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let browser_auth = browser_auth::BrowserAuthConfig::required(
        SESSION_SECRET,
        false,
        browser_auth::SessionPolicy::BetterAuth,
    )
    .unwrap();
    let mutation_policy =
        browser_auth::BrowserMutationPolicy::new(&[ALLOWED_ORIGIN.to_owned()]).unwrap();
    let config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "http://127.0.0.1:1",
        "native-chat-http-ingress-authorization-key",
    )
    .unwrap()
    .with_browser_auth(browser_auth)
    .unwrap()
    .with_native_chat_mutation_policy(mutation_policy);
    let runtime = PublicIngressRuntime::bind(config, foundation).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let cookie = signed_session_cookie(&token);
    let turn_url = format!(
        "{base}/api/chats/{}/messages/stream/turn?generationId={generation_id}",
        fixture::CHAT
    );
    let events_url = format!(
        "{base}/api/chats/{}/messages/stream/events?generationId={generation_id}&afterSeq=0",
        fixture::CHAT
    );
    let empty_hash = format!("{:x}", Sha256::digest(b""));

    let (turn_status, turn_bytes) = request(
        &client,
        Method::GET,
        turn_url.clone(),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(turn_status, StatusCode::OK);
    let turn: serde_json::Value = serde_json::from_slice(&turn_bytes).unwrap();
    assert_eq!(turn["executionAuthority"], "native_rust");
    assert_eq!(turn["generationId"], generation_id);
    assert_eq!(turn["generationStatus"], "starting");
    assert_eq!(turn["attemptEpoch"], 1);
    assert_eq!(turn["assistantMessage"], serde_json::Value::Null);
    assert_eq!(turn["lastClientCheckpointSeq"], serde_json::Value::Null);
    assert_eq!(turn["lastClientCheckpointHash"], serde_json::Value::Null);

    let legacy_generation_id = "71000000-0000-4000-8000-000000000077";
    sqlx::query(
        "INSERT INTO chat_generations(id,org_id,conversation_id,status)
         VALUES($1::uuid,$2::uuid,$3::uuid,'completed')",
    )
    .bind(legacy_generation_id)
    .bind(fixture::ORG)
    .bind(fixture::CHAT)
    .execute(&database.pool)
    .await
    .unwrap();
    let legacy_turn_url = format!(
        "{base}/api/chats/{}/messages/stream/turn?generationId={legacy_generation_id}",
        fixture::CHAT
    );
    let (legacy_status, legacy_bytes) = request(
        &client,
        Method::GET,
        legacy_turn_url,
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(legacy_status, StatusCode::OK);
    let legacy_turn: serde_json::Value = serde_json::from_slice(&legacy_bytes).unwrap();
    assert_eq!(legacy_turn["executionAuthority"], "legacy_ts");
    assert_eq!(legacy_turn["generationId"], legacy_generation_id);
    assert_eq!(legacy_turn["attemptEpoch"], 1);
    assert_eq!(legacy_turn["controlVersion"], 0);
    assert!(legacy_turn.get("sourceMessage").is_none());
    assert!(legacy_turn.get("runId").is_none());

    let (events_status, events_bytes) = request(
        &client,
        Method::GET,
        events_url.clone(),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(events_status, StatusCode::OK);
    let event_page: serde_json::Value = serde_json::from_slice(&events_bytes).unwrap();
    assert_eq!(event_page["events"][0]["generationSeq"], 1);
    assert_eq!(event_page["events"][0]["eventKind"], "generation_started");
    assert_eq!(event_page["events"][0]["payload"], serde_json::json!({}));
    for bytes in [&turn_bytes, &events_bytes] {
        let serialized = String::from_utf8_lossy(bytes);
        assert!(!serialized.contains(PRIVATE_THREAD));
        assert!(!serialized.contains(PRIVATE_OWNER));
        assert!(!serialized.contains("providerThreadId"));
        assert!(!serialized.contains("ownerToken"));
        assert!(!serialized.contains("checkpointJson"));
        assert!(!serialized.contains("sessionIdBefore"));
        assert!(!serialized.contains("sessionIdAfter"));
    }

    let checkpoint_url = format!(
        "{base}/api/chats/{}/messages/stream/checkpoint",
        fixture::CHAT
    );
    let checkpoint = serde_json::json!({
        "generationId": generation_id.clone(),
        "attemptEpoch": 1,
        "generationSeq": 0,
        "renderedBodyHash": empty_hash.clone(),
    });
    let stop_url = format!("{base}/api/chats/{}/messages/stream/stop", fixture::CHAT);
    let action_id = uuid::Uuid::new_v4().to_string();
    let stop = serde_json::json!({
        "controlActionId": action_id,
        "expectedGenerationId": generation_id.clone(),
        "expectedAttemptEpoch": 1,
        "expectedControlVersion": 0,
        "lastCommittedRenderSeq": 0,
        "renderedBodyHash": empty_hash.clone(),
    });
    let before_rejected_writes = control_state(&database.pool, &generation_id).await;
    let before_rejected_origin_session = session_auth_state(&database.pool, &session_id).await;
    for (url, body) in [(&checkpoint_url, &checkpoint), (&stop_url, &stop)] {
        for origin in [None, Some("https://untrusted.invalid")] {
            let (status, _) = request(
                &client,
                Method::POST,
                url.to_string(),
                Some(&cookie),
                origin,
                Some((*body).clone()),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
        }
    }
    assert_eq!(
        control_state(&database.pool, &generation_id).await,
        before_rejected_writes,
        "missing or foreign Origin must leave checkpoint, Stop, events, and audit untouched"
    );
    assert_eq!(
        session_auth_state(&database.pool, &session_id).await,
        before_rejected_origin_session,
        "Native Chat must not refresh a BetterAuth session before rejecting Origin"
    );

    let (checkpoint_status, checkpoint_bytes) = request(
        &client,
        Method::POST,
        checkpoint_url,
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(checkpoint),
    )
    .await;
    assert_eq!(checkpoint_status, StatusCode::OK);
    let checkpoint_receipt: serde_json::Value = serde_json::from_slice(&checkpoint_bytes).unwrap();
    assert_eq!(checkpoint_receipt["generationSeq"], 0);
    assert_eq!(checkpoint_receipt["advanced"], true);

    let (stop_status, stop_bytes) = request(
        &client,
        Method::POST,
        stop_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(stop.clone()),
    )
    .await;
    assert_eq!(stop_status, StatusCode::OK);
    let first_stop: serde_json::Value = serde_json::from_slice(&stop_bytes).unwrap();
    assert_eq!(first_stop["stopped"], false);
    assert_eq!(first_stop["disposition"], "stopping");
    assert_eq!(first_stop["idempotent"], false);
    assert_eq!(first_stop["acceptedThroughSeq"], 0);
    assert_eq!(first_stop["frozenBodyHash"], empty_hash);
    let (retry_status, retry_bytes) = request(
        &client,
        Method::POST,
        stop_url,
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(stop),
    )
    .await;
    assert_eq!(retry_status, StatusCode::OK);
    let retry_stop: serde_json::Value = serde_json::from_slice(&retry_bytes).unwrap();
    assert_eq!(retry_stop["stopped"], false);
    assert_eq!(retry_stop["disposition"], "stopping");
    assert_eq!(retry_stop["idempotent"], true);
    assert_eq!(retry_stop["controlActionId"], first_stop["controlActionId"]);
    assert_eq!(
        retry_stop["acceptedThroughSeq"],
        first_stop["acceptedThroughSeq"]
    );
    assert_eq!(retry_stop["frozenBodyHash"], first_stop["frozenBodyHash"]);

    seed_foreign_native_target(&database.pool, &user_id).await;
    let missing_chat = "31000000-0000-4000-8000-000000000002";
    let foreign_url = format!(
        "{base}/api/chats/{FOREIGN_CHAT}/messages/stream/turn?generationId={FOREIGN_GENERATION}"
    );
    let missing_url = format!(
        "{base}/api/chats/{missing_chat}/messages/stream/turn?generationId={FOREIGN_GENERATION}"
    );
    let (foreign_status, foreign_body) = request(
        &client,
        Method::GET,
        foreign_url.clone(),
        Some(&cookie),
        None,
        None,
    )
    .await;
    let (missing_status, missing_body) =
        request(&client, Method::GET, missing_url, Some(&cookie), None, None).await;
    assert_eq!(foreign_status, StatusCode::NOT_FOUND);
    assert_eq!(missing_status, StatusCode::NOT_FOUND);
    assert_eq!(foreign_body, missing_body);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&foreign_body).unwrap(),
        serde_json::json!({"error":"chat_not_found"})
    );

    let foreign_events_url = format!(
        "{base}/api/chats/{FOREIGN_CHAT}/messages/stream/events?generationId={FOREIGN_GENERATION}&afterSeq=0"
    );
    let foreign_checkpoint_url =
        format!("{base}/api/chats/{FOREIGN_CHAT}/messages/stream/checkpoint");
    let foreign_stop_url = format!("{base}/api/chats/{FOREIGN_CHAT}/messages/stream/stop");
    let foreign_checkpoint = serde_json::json!({
        "generationId": FOREIGN_GENERATION,
        "attemptEpoch": 1,
        "generationSeq": 0,
        "renderedBodyHash": empty_hash.clone(),
    });
    let foreign_stop = serde_json::json!({
        "controlActionId": uuid::Uuid::new_v4().to_string(),
        "expectedGenerationId": FOREIGN_GENERATION,
        "expectedAttemptEpoch": 1,
        "expectedControlVersion": 0,
        "lastCommittedRenderSeq": 0,
        "renderedBodyHash": empty_hash.clone(),
    });
    let before_foreign_requests = control_state(&database.pool, FOREIGN_GENERATION).await;
    for url in [foreign_url.clone(), foreign_events_url] {
        let (status, body) = request(&client, Method::GET, url, Some(&cookie), None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, foreign_body);
    }
    for (url, body) in [
        (&foreign_checkpoint_url, foreign_checkpoint),
        (&foreign_stop_url, foreign_stop),
    ] {
        let (status, response_body) = request(
            &client,
            Method::POST,
            url.clone(),
            Some(&cookie),
            Some(ALLOWED_ORIGIN),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(response_body, foreign_body);
    }
    assert_eq!(
        control_state(&database.pool, FOREIGN_GENERATION).await,
        before_foreign_requests,
        "unauthorized foreign reads and controls cannot write the foreign generation ledger"
    );

    let (final_events_status, final_events_bytes) =
        request(&client, Method::GET, events_url, Some(&cookie), None, None).await;
    assert_eq!(final_events_status, StatusCode::OK);
    let final_events: serde_json::Value = serde_json::from_slice(&final_events_bytes).unwrap();
    assert_eq!(final_events["events"].as_array().unwrap().len(), 4);
    assert_eq!(final_events["events"][1]["eventKind"], "client_checkpoint");
    assert_eq!(final_events["events"][2]["eventKind"], "stop_requested");
    assert_eq!(final_events["events"][3]["eventKind"], "output_cutoff");
    let serialized = String::from_utf8_lossy(&final_events_bytes);
    assert!(!serialized.contains(PRIVATE_THREAD));
    assert!(!serialized.contains(PRIVATE_OWNER));
    assert!(!serialized.contains("providerThreadId"));
    assert!(!serialized.contains("ownerToken"));

    let (before_expiry_status, _) = request(
        &client,
        Method::GET,
        turn_url.clone(),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(before_expiry_status, StatusCode::OK);
    sqlx::query("DELETE FROM session WHERE id=$1")
        .bind(&session_id)
        .execute(&database.pool)
        .await
        .unwrap();
    let before_revoked_read = control_state(&database.pool, &generation_id).await;
    let (revoked_status, _) =
        request(&client, Method::GET, turn_url, Some(&cookie), None, None).await;
    assert_eq!(revoked_status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        control_state(&database.pool, &generation_id).await,
        before_revoked_read,
        "revoked read cannot change the control ledger"
    );
    assert!(
        !host.provider_started(),
        "control routes must not dispatch a provider"
    );

    control.stop(true).await;
    task.await.unwrap().unwrap();
    database.pool.close().await;
}

#[actix_web::test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, PostgreSQL binaries and a synthetic provider"]
async fn public_send_stream_is_durable_and_exact_retry_never_dispatches_twice() {
    let database = fixture::Database::start().await;
    let host = fixture::FixtureHost::new("complete");
    let (actor, _other_run, _other_attempt) = fixture::admitted(&database, &host).await;
    let user_id = actor.actor().id.clone();
    sqlx::query(
        "INSERT INTO chat_conversations
           (id,org_id,title,conversation_kind,created_by_user_id,status,preferred_agent_id)
         VALUES($1::uuid,$2::uuid,'Native public send fixture','chat',$3,'active',$4::uuid)",
    )
    .bind(SEND_CHAT)
    .bind(fixture::ORG)
    .bind(&user_id)
    .bind(fixture::CEO)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body)
         VALUES($1::uuid,$2::uuid,'assistant','message','completed',$3)",
    )
    .bind(fixture::ORG)
    .bind(SEND_CHAT)
    .bind("old history must not be sent as a new turn")
    .execute(&database.pool)
    .await
    .unwrap();

    let token = format!("native-public-send-session-{}", uuid::Uuid::new_v4());
    let session_id = format!("native-public-send-session-row-{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now(),now())",
    )
    .bind(&session_id)
    .bind(&user_id)
    .bind(&token)
    .execute(&database.pool)
    .await
    .unwrap();

    let database_url = format!(
        "postgresql://postgres@127.0.0.1:{}/postgres",
        database.pool.connect_options().get_port()
    );
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url),
            actor_envelope_key: Some(rudder_auth_core::SigningKey::new(AUTH_ENVELOPE_KEY).unwrap()),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let worker = foundation.native_chat_worker.clone().unwrap();
    let browser_auth = browser_auth::BrowserAuthConfig::required(
        SESSION_SECRET,
        false,
        browser_auth::SessionPolicy::BetterAuth,
    )
    .unwrap();
    let mutation_policy =
        browser_auth::BrowserMutationPolicy::new(&[ALLOWED_ORIGIN.to_owned()]).unwrap();
    let runtime_config = crate::NativeChatPublicRuntime::new(
        host.context().clone(),
        host.paths(),
        std::time::Duration::from_secs(30),
    )
    .unwrap();
    let base_config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "http://127.0.0.1:1",
        "native-chat-http-ingress-authorization-key",
    )
    .unwrap()
    .with_browser_auth(browser_auth)
    .unwrap()
    .with_native_chat_mutation_policy(mutation_policy);
    let runtime = PublicIngressRuntime::bind(
        base_config.clone().with_native_chat_runtime(runtime_config),
        Arc::clone(&foundation),
    )
    .unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let stop_server = runtime.control();
    let server_task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let cookie = signed_session_cookie(&token);
    let url = format!("{base}/api/chats/{SEND_CHAT}/messages/stream");
    let input = serde_json::json!({
        "body":"Only this new input reaches the provider 🌍",
        "clientMutationId":"native-public-send-retry-1",
        "modelOverride":null,
        "effortOverride":null,
    });

    let (origin_status, _) = request(
        &client,
        Method::POST,
        url.clone(),
        Some(&cookie),
        Some("http://attacker.invalid"),
        Some(input.clone()),
    )
    .await;
    assert_eq!(origin_status, StatusCode::FORBIDDEN);
    let mut unsupported = input.clone();
    unsupported["modelOverride"] = serde_json::json!("caller-selected-model");
    let (unsupported_status, _) = request(
        &client,
        Method::POST,
        url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(unsupported),
    )
    .await;
    assert_eq!(unsupported_status, StatusCode::UNPROCESSABLE_ENTITY);
    let before_admission: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND role='user' AND client_mutation_id=$3",
    )
    .bind(fixture::ORG)
    .bind(SEND_CHAT)
    .bind("native-public-send-retry-1")
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        before_admission, 0,
        "rejected requests cannot write admission state"
    );

    // Headers arrive only after the D1 receipt is committed and the reserved
    // worker has been handed off. Dropping this response exercises disconnect
    // after commit without canceling the process-owned execution.
    let first_response = client
        .request(Method::POST, &url)
        .insert_header((header::COOKIE, cookie.as_str()))
        .insert_header((header::ORIGIN, ALLOWED_ORIGIN))
        .insert_header((header::CONTENT_TYPE, "application/json"))
        .send_body(serde_json::to_vec(&input).unwrap())
        .await
        .unwrap();
    assert_eq!(first_response.status(), StatusCode::OK);
    drop(first_response);
    stop_server.stop(true).await;
    server_task.await.unwrap().unwrap();

    // Finalization clears the live lease while retaining its historical owner
    // fence. A finished turn must remain readable after a response is lost.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let terminal: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM chat_generations WHERE conversation_id=$1::uuid
                 AND status='completed' AND runtime_terminal_at IS NOT NULL
                 AND control_owner_token IS NOT NULL AND control_lease_expires_at IS NULL)",
            )
            .bind(SEND_CHAT)
            .fetch_one(&database.pool)
            .await
            .unwrap();
            if terminal {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("disconnected request does not cancel worker finalization");

    let replay_actor = persistence_chat::BrowserPrincipal::from_trusted_browser_auth(
        &user_id,
        fixture::ORG,
        &session_id,
        persistence_chat::BrowserCredentialBinding::session(
            &session_id,
            Sha256::digest(token.as_bytes()).into(),
        ),
    )
    .unwrap();
    let replay_command = persistence_chat::Request::SubmitNativeChatTurn {
        conversation_id: SEND_CHAT.to_owned(),
        client_mutation_id: "native-public-send-retry-1".to_owned(),
        body: input["body"].as_str().unwrap().to_owned(),
    };
    let receipt = persistence_chat::lookup_submission(
        &database.pool,
        &replay_actor,
        fixture::ORG,
        &replay_command,
    )
    .await
    .expect("completed source receipt remains readable")
    .expect("completed submission remains present");
    assert!(
        send::reconciliation_projection(
            receipt.clone(),
            fixture::ORG,
            SEND_CHAT,
            "native-public-send-retry-1",
        )
        .is_some(),
        "synthetic completed receipt must satisfy public projection: {receipt}"
    );

    // Recovery of this exact committed request is a read/stream operation; it
    // remains available even when trusted host dispatch config is absent.
    // A restarted server owns a fresh connection pool. Reusing the old pool
    // after terminating its Actix workers leaves its connection tasks attached
    // to the stopped runtime and does not model a process restart.
    let mut retry_foundation = crate::AppState::new((*foundation.config).clone()).unwrap();
    retry_foundation.native_chat_worker = None;
    let retry_runtime =
        PublicIngressRuntime::bind(base_config, Arc::new(retry_foundation)).unwrap();
    let retry_base = format!("http://{}", retry_runtime.bound_addr());
    let retry_server_control = retry_runtime.control();
    let retry_server_task = actix_web::rt::spawn(retry_runtime.run());
    let (retry_status, retry_bytes) = request(
        &client,
        Method::POST,
        format!("{retry_base}/api/chats/{SEND_CHAT}/messages/stream"),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(input),
    )
    .await;
    assert_eq!(retry_status, StatusCode::OK);
    let lines = retry_bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lines.first().unwrap()["type"], "ack");
    assert_eq!(
        lines[0]["userMessage"]["body"],
        "Only this new input reaches the provider 🌍"
    );
    assert_eq!(lines[0]["generationSeq"], 0);
    assert_eq!(lines[0]["bodyHash"], format!("{:x}", Sha256::digest(b"")));
    let snapshot = lines
        .iter()
        .find(|line| line["type"] == "assistant_snapshot")
        .unwrap();
    assert_eq!(snapshot["body"], "synthetic answer");
    let final_event = lines.iter().find(|line| line["type"] == "final").unwrap();
    assert_eq!(final_event["messages"][0]["body"], "synthetic answer");
    assert_eq!(lines.iter().filter(|line| line["type"] == "ack").count(), 1);
    let serialized = String::from_utf8_lossy(&retry_bytes);
    assert!(!serialized.contains(PRIVATE_THREAD));
    assert!(!serialized.contains(PRIVATE_OWNER));
    assert!(!serialized.contains("providerThreadId"));
    assert!(!serialized.contains("turnId"));
    assert!(!serialized.contains("connectionClaimId"));

    let source = sqlx::query(
        "SELECT id::text FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND role='user' AND client_mutation_id=$3",
    )
    .bind(fixture::ORG)
    .bind(SEND_CHAT)
    .bind("native-public-send-retry-1")
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let source_id: String = source.try_get("id").unwrap();
    let generation = sqlx::query(
        "SELECT id::text,status,native_admission_hold FROM chat_generations
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND source_message_id=$3::uuid",
    )
    .bind(fixture::ORG)
    .bind(SEND_CHAT)
    .bind(&source_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let generation_id: String = generation.try_get("id").unwrap();
    assert_eq!(
        generation.try_get::<String, _>("status").unwrap(),
        "completed"
    );
    assert!(
        !generation
            .try_get::<bool, _>("native_admission_hold")
            .unwrap()
    );
    let run = sqlx::query(
        "SELECT id::text,status,native_admission_hold FROM heartbeat_runs
         WHERE org_id=$1::uuid AND chat_generation_id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&generation_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let run_id: String = run.try_get("id").unwrap();
    assert_eq!(run.try_get::<String, _>("status").unwrap(), "succeeded");
    assert!(!run.try_get::<bool, _>("native_admission_hold").unwrap());
    let attempts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        attempts, 1,
        "durable exact retry cannot create another Attempt"
    );

    let frames = host.events();
    let thread_starts = frames
        .iter()
        .filter(|event| event["received"]["method"] == "thread/start")
        .count();
    assert_eq!(
        thread_starts, 1,
        "durable exact retry never starts another provider Thread"
    );
    let provider_wire = serde_json::to_string(&frames).unwrap();
    assert!(provider_wire.contains("Only this new input reaches the provider 🌍"));
    assert!(!provider_wire.contains("old history must not be sent as a new turn"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
               AND role='user' AND client_mutation_id=$3",
        )
        .bind(fixture::ORG)
        .bind(SEND_CHAT)
        .bind("native-public-send-retry-1")
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        1,
        "exact retry preserves one source message"
    );

    // The reconciliation route is a strict, read-only lookup. Exercise it
    // against the completed admission with no worker runtime configured on
    // this server, then prove every business ledger and provider dispatch
    // count remains unchanged.
    let reconcile_url = format!("{retry_base}/api/chats/{SEND_CHAT}/messages/stream/reconcile");
    let reconcile_input = serde_json::json!({
        "body":"Only this new input reaches the provider 🌍",
        "clientMutationId":"native-public-send-retry-1",
    });
    let before_reconcile = chat_business_counts(&database.pool, SEND_CHAT).await;
    let before_provider_frames = host.events().len();

    let (accepted_status, accepted_bytes) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(reconcile_input.clone()),
    )
    .await;
    assert_eq!(accepted_status, StatusCode::OK);
    let accepted: serde_json::Value = serde_json::from_slice(&accepted_bytes).unwrap();
    assert_eq!(accepted["outcome"], "accepted");
    assert_eq!(accepted["clientMutationId"], "native-public-send-retry-1");
    assert_eq!(accepted["message"]["id"], source_id);
    assert_eq!(accepted["message"]["runId"], run_id);
    assert_eq!(accepted["generationId"], generation_id);
    assert_eq!(accepted["runId"], run_id);
    assert_eq!(accepted["attemptEpoch"], 1);
    assert_eq!(accepted["generationSeq"], 0);
    assert_eq!(accepted["bodyHash"], format!("{:x}", Sha256::digest(b"")));
    assert_eq!(accepted["generationStatus"], "completed");
    assert_eq!(accepted["runStatus"], "succeeded");
    assert_eq!(accepted["runtimeTerminal"], true);
    assert_eq!(
        accepted
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "outcome",
            "clientMutationId",
            "message",
            "generationId",
            "runId",
            "attemptEpoch",
            "generationSeq",
            "bodyHash",
            "generationStatus",
            "runStatus",
            "runtimeTerminal",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    let accepted_wire = String::from_utf8_lossy(&accepted_bytes);
    assert!(!accepted_wire.contains(PRIVATE_THREAD));
    assert!(!accepted_wire.contains(PRIVATE_OWNER));
    assert!(!accepted_wire.contains("providerThreadId"));
    assert!(!accepted_wire.contains("ownerToken"));

    let mut not_found_input = reconcile_input.clone();
    not_found_input["clientMutationId"] = serde_json::json!("native-never-admitted");
    let (not_found_status, not_found_bytes) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(not_found_input),
    )
    .await;
    assert_eq!(not_found_status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&not_found_bytes).unwrap(),
        serde_json::json!({
            "outcome":"not_found",
            "clientMutationId":"native-never-admitted",
        })
    );

    let mut mismatch_input = reconcile_input.clone();
    mismatch_input["body"] = serde_json::json!("different body under the same mutation id");
    let (mismatch_status, _) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(mismatch_input),
    )
    .await;
    assert_eq!(mismatch_status, StatusCode::CONFLICT);

    let mut unsupported_input = reconcile_input.clone();
    unsupported_input["files"] = serde_json::json!([]);
    let (unsupported_status, _) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(unsupported_input),
    )
    .await;
    assert_eq!(unsupported_status, StatusCode::BAD_REQUEST);
    let (unauthorized_status, _) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        None,
        Some(ALLOWED_ORIGIN),
        Some(reconcile_input.clone()),
    )
    .await;
    assert_eq!(unauthorized_status, StatusCode::UNAUTHORIZED);
    let (origin_status, _) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some("http://attacker.invalid"),
        Some(reconcile_input.clone()),
    )
    .await;
    assert_eq!(origin_status, StatusCode::FORBIDDEN);
    let (missing_origin_status, _) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        None,
        Some(reconcile_input.clone()),
    )
    .await;
    assert_eq!(missing_origin_status, StatusCode::FORBIDDEN);

    let missing_chat_url = format!(
        "{retry_base}/api/chats/21000000-0000-4000-8000-000000000499/messages/stream/reconcile"
    );
    let (missing_chat_status, missing_chat_bytes) = request(
        &client,
        Method::POST,
        missing_chat_url,
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(reconcile_input.clone()),
    )
    .await;
    assert_eq!(missing_chat_status, StatusCode::NOT_FOUND);

    seed_foreign_native_target(&database.pool, &user_id).await;
    let foreign_chat_url =
        format!("{retry_base}/api/chats/{FOREIGN_CHAT}/messages/stream/reconcile");
    let (foreign_chat_status, foreign_chat_bytes) = request(
        &client,
        Method::POST,
        foreign_chat_url,
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(reconcile_input),
    )
    .await;
    assert_eq!(foreign_chat_status, StatusCode::NOT_FOUND);
    assert_eq!(foreign_chat_bytes, missing_chat_bytes);

    assert_eq!(
        chat_business_counts(&database.pool, SEND_CHAT).await,
        before_reconcile,
        "reconciliation and all rejected lookups must not mutate business ledgers"
    );
    assert_eq!(
        host.events().len(),
        before_provider_frames,
        "reconciliation must never dispatch or relaunch a provider"
    );

    retry_server_control.stop(true).await;
    retry_server_task.await.unwrap().unwrap();
    worker
        .shutdown(std::time::Duration::from_secs(5))
        .await
        .unwrap();
    database.pool.close().await;
}

#[actix_web::test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, PostgreSQL binaries and a synthetic provider"]
async fn public_first_send_creates_and_dispatches_one_exact_native_chat_turn() {
    let database = fixture::Database::start().await;
    let host = fixture::FixtureHost::new("complete");
    let (actor, _existing_run, _existing_attempt) = fixture::admitted(&database, &host).await;
    let user_id = actor.actor().id.clone();
    let token = format!("native-public-first-send-session-{}", uuid::Uuid::new_v4());
    let session_id = format!(
        "native-public-first-send-session-row-{}",
        uuid::Uuid::new_v4()
    );
    sqlx::query(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now(),now())",
    )
    .bind(&session_id)
    .bind(&user_id)
    .bind(&token)
    .execute(&database.pool)
    .await
    .unwrap();

    let database_url = format!(
        "postgresql://postgres@127.0.0.1:{}/postgres",
        database.pool.connect_options().get_port()
    );
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url.clone()),
            actor_envelope_key: Some(rudder_auth_core::SigningKey::new(AUTH_ENVELOPE_KEY).unwrap()),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let browser_auth = browser_auth::BrowserAuthConfig::required(
        SESSION_SECRET,
        false,
        browser_auth::SessionPolicy::BetterAuth,
    )
    .unwrap();
    let mutation_policy =
        browser_auth::BrowserMutationPolicy::new(&[ALLOWED_ORIGIN.to_owned()]).unwrap();
    let runtime_config = crate::NativeChatPublicRuntime::new(
        host.context().clone(),
        host.paths(),
        std::time::Duration::from_secs(30),
    )
    .unwrap();
    let config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "http://127.0.0.1:1",
        "native-chat-first-send-http-ingress-key",
    )
    .unwrap()
    .with_browser_auth(browser_auth)
    .unwrap()
    .with_native_chat_mutation_policy(mutation_policy)
    .with_native_chat_runtime(runtime_config);
    let mut recovery_config = config.clone();
    recovery_config.native_chat_runtime = None;
    let runtime = PublicIngressRuntime::bind(config, Arc::clone(&foundation)).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let stop_server = runtime.control();
    let server_task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let cookie = signed_session_cookie(&token);
    let mutation = format!("native-public-first-send-{}", uuid::Uuid::new_v4());
    let url = format!("{base}/api/orgs/{}/chats/messages/stream", fixture::ORG);
    let input = serde_json::json!({
        "body":"First message reaches one native Codex Turn 🌍",
        "clientMutationId":mutation,
        "preferredAgentId":fixture::CEO,
        "title":"First-send HTTP fixture",
        "issueCreationMode":"manual_approval",
        "modelOverride":null,
        "effortOverride":null,
        "planMode":false,
        "contextLinks":[],
    });

    let mut unsupported = input.clone();
    unsupported["contextLinks"] = serde_json::json!([{"url":"https://example.invalid"}]);
    let (unsupported_status, _) = request(
        &client,
        Method::POST,
        url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(unsupported),
    )
    .await;
    assert_eq!(unsupported_status, StatusCode::UNPROCESSABLE_ENTITY);
    let (foreign_status, _) = request(
        &client,
        Method::POST,
        format!(
            "{base}/api/orgs/{}/chats/messages/stream",
            fixture::support::OTHER
        ),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(input.clone()),
    )
    .await;
    assert_eq!(foreign_status, StatusCode::NOT_FOUND);
    let no_foreign_write: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_conversations
         WHERE org_id=$1::uuid AND created_by_user_id=$2 AND initial_client_mutation_id=$3",
    )
    .bind(fixture::support::OTHER)
    .bind(&user_id)
    .bind(&mutation)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(no_foreign_write, 0);

    let (status, bytes) = request(
        &client,
        Method::POST,
        url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(input.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let lines = bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lines.first().unwrap()["type"], "ack");
    assert_eq!(
        lines[0]["userMessage"]["body"],
        "First message reaches one native Codex Turn 🌍"
    );
    assert_eq!(
        lines.iter().find(|line| line["type"] == "final").unwrap()["messages"][0]["body"],
        "synthetic answer"
    );

    let persisted: (String, String, String, String, String, String, String) = sqlx::query_as(
        "SELECT c.id::text,m.id::text,m.body,g.id::text,r.id::text,g.status,r.status
         FROM chat_conversations c
         JOIN chat_messages m ON m.org_id=c.org_id AND m.conversation_id=c.id
         JOIN chat_generations g ON g.org_id=m.org_id AND g.source_message_id=m.id
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE c.org_id=$1::uuid AND c.created_by_user_id=$2
           AND c.initial_client_mutation_id=$3 AND m.client_mutation_id=$3
           AND m.role='user'",
    )
    .bind(fixture::ORG)
    .bind(&user_id)
    .bind(&mutation)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        persisted.2,
        "First message reaches one native Codex Turn 🌍"
    );
    assert_eq!(persisted.5, "completed");
    assert_eq!(persisted.6, "succeeded");

    let thread_starts = host
        .events()
        .iter()
        .filter(|event| event["received"]["method"] == "thread/start")
        .count();
    assert_eq!(thread_starts, 1);
    let turn_start = host
        .events()
        .into_iter()
        .find(|event| event.get("turnStart").is_some())
        .unwrap();
    assert_eq!(
        turn_start["turnStart"]["params"]["input"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        turn_start["turnStart"]["params"]["input"][0]["text"],
        "First message reaches one native Codex Turn 🌍"
    );
    assert!(turn_start["turnStart"]["params"].get("history").is_none());

    // The same id/body/settings is a read-only exact retry and cannot launch a
    // second worker or Codex Thread after the committed response is replayed.
    let (retry_status, retry_bytes) = request(
        &client,
        Method::POST,
        url,
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(input.clone()),
    )
    .await;
    assert_eq!(retry_status, StatusCode::OK);
    let retry_ack: serde_json::Value = serde_json::from_slice(
        retry_bytes
            .split(|byte| *byte == b'\n')
            .find(|line| !line.is_empty())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(retry_ack["type"], "ack");
    assert_eq!(retry_ack["userMessage"]["id"], persisted.1);
    assert_eq!(
        host.events()
            .iter()
            .filter(|event| event["received"]["method"] == "thread/start")
            .count(),
        1
    );

    stop_server.stop(true).await;
    server_task.await.unwrap().unwrap();
    // Read-only first-send reconciliation survives disabling new dispatch and
    // no longer consults the Agent's mutable execution configuration.
    sqlx::query(
        "UPDATE agents SET agent_runtime_config='{}'::jsonb WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(fixture::CEO)
    .execute(&database.pool)
    .await
    .unwrap();
    // A restart constructs a fresh SQLx pool on the new listener runtime;
    // connections belonging to the stopped Actix worker must not be reused.
    let recovery_foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url),
            actor_envelope_key: Some(rudder_auth_core::SigningKey::new(AUTH_ENVELOPE_KEY).unwrap()),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let recovery = PublicIngressRuntime::bind(recovery_config, recovery_foundation).unwrap();
    let recovery_base = format!("http://{}", recovery.bound_addr());
    let recovery_control = recovery.control();
    let recovery_task = actix_web::rt::spawn(recovery.run());
    let reconcile_url = format!(
        "{recovery_base}/api/orgs/{}/chats/messages/stream/reconcile",
        fixture::ORG
    );
    let before = chat_business_counts(&database.pool, &persisted.0).await;
    let (reconciled_status, reconciled_bytes) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(input.clone()),
    )
    .await;
    assert_eq!(
        reconciled_status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&reconciled_bytes)
    );
    let reconciled: serde_json::Value = serde_json::from_slice(&reconciled_bytes).unwrap();
    assert_eq!(reconciled["outcome"], "accepted");
    assert_eq!(reconciled["conversation"]["id"], persisted.0);
    assert_eq!(reconciled["message"]["id"], persisted.1);
    assert_eq!(reconciled["generationId"], persisted.3);
    assert_eq!(reconciled["runId"], persisted.4);
    assert_eq!(
        reconciled["conversation"]["chatRuntime"]["model"],
        fixture::MODEL
    );
    // Current preferences may change while an acknowledgement is lost.
    // Recover the original execution without claiming that its old runtime
    // describes the newly unconfigured Conversation.
    sqlx::query(
        "UPDATE chat_conversations SET preferred_agent_id=NULL,plan_mode=true
        WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&persisted.0)
    .execute(&database.pool)
    .await
    .unwrap();
    let (changed_preference_status, changed_preference_bytes) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(input.clone()),
    )
    .await;
    assert_eq!(
        changed_preference_status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&changed_preference_bytes)
    );
    let changed_preference: serde_json::Value =
        serde_json::from_slice(&changed_preference_bytes).unwrap();
    assert_eq!(changed_preference["runId"], persisted.4);
    assert!(changed_preference["conversation"]["preferredAgentId"].is_null());
    assert_eq!(changed_preference["conversation"]["planMode"], true);
    assert_eq!(
        changed_preference["conversation"]["chatRuntime"]["available"],
        false
    );
    assert!(changed_preference["conversation"]["chatRuntime"]["agentRuntimeType"].is_null());
    let mut changed = input.clone();
    changed["body"] = serde_json::json!("different accepted input");
    let (changed_status, _) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(changed),
    )
    .await;
    assert_eq!(changed_status, StatusCode::CONFLICT);
    let mut missing = input.clone();
    missing["clientMutationId"] = serde_json::json!("missing-first-send-reconcile");
    let (missing_status, missing_bytes) = request(
        &client,
        Method::POST,
        reconcile_url.clone(),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(missing),
    )
    .await;
    assert_eq!(missing_status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&missing_bytes).unwrap()["outcome"],
        "not_found"
    );
    let (origin_status, _) = request(
        &client,
        Method::POST,
        reconcile_url,
        Some(&cookie),
        Some("https://foreign.invalid"),
        Some(input),
    )
    .await;
    assert_eq!(origin_status, StatusCode::FORBIDDEN);
    assert_eq!(
        before,
        chat_business_counts(&database.pool, &persisted.0).await
    );
    assert_eq!(
        host.events()
            .iter()
            .filter(|event| event["received"]["method"] == "thread/start")
            .count(),
        1
    );
    recovery_control.stop(false).await;
    recovery_task.await.unwrap().unwrap();
    database.pool.close().await;
}

#[actix_web::test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, PostgreSQL binaries and a synthetic provider"]
async fn expired_claim_after_admission_ack_is_recoverable_and_exact_retry_never_dispatches() {
    let database = fixture::Database::start().await;
    let host = fixture::FixtureHost::new("complete");
    let (actor, _other_run, _other_attempt) = fixture::admitted(&database, &host).await;
    let user_id = actor.actor().id.clone();
    sqlx::query(
        "INSERT INTO chat_conversations
           (id,org_id,title,conversation_kind,created_by_user_id,status,preferred_agent_id)
         VALUES($1::uuid,$2::uuid,'Native expired-claim fixture','chat',$3,'active',$4::uuid)",
    )
    .bind(SEND_CHAT)
    .bind(fixture::ORG)
    .bind(&user_id)
    .bind(fixture::CEO)
    .execute(&database.pool)
    .await
    .unwrap();

    let expired_token = format!("native-expired-claim-session-{}", uuid::Uuid::new_v4());
    let expired_session = format!("native-expired-claim-row-{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now(),now())",
    )
    .bind(&expired_session)
    .bind(&user_id)
    .bind(&expired_token)
    .execute(&database.pool)
    .await
    .unwrap();

    // A deferred commit hook expires only the request session after D1 has
    // performed its last authorization check but before the admission commit
    // returns to the ack sender. The executor's captured principal therefore
    // cannot claim after the accepted input is durable.
    sqlx::query(
        "CREATE FUNCTION test_expire_native_chat_admission_session() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN
           IF NEW.event_kind='generation_started' THEN
             UPDATE session SET expires_at=clock_timestamp()-interval '1 second'
              WHERE token LIKE 'native-expired-claim-session-%'
                AND user_id=(
                  SELECT c.created_by_user_id
                    FROM chat_generations g
                    JOIN chat_conversations c
                      ON c.org_id=g.org_id AND c.id=g.conversation_id
                   WHERE g.id=NEW.generation_id
                );
           END IF;
           RETURN NEW;
         END $$",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE CONSTRAINT TRIGGER test_expire_native_chat_admission_session
         AFTER INSERT ON chat_generation_events DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION test_expire_native_chat_admission_session()",
    )
    .execute(&database.pool)
    .await
    .unwrap();

    let database_url = format!(
        "postgresql://postgres@127.0.0.1:{}/postgres",
        database.pool.connect_options().get_port()
    );
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url),
            actor_envelope_key: Some(rudder_auth_core::SigningKey::new(AUTH_ENVELOPE_KEY).unwrap()),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let worker = foundation.native_chat_worker.clone().unwrap();
    let browser_auth = browser_auth::BrowserAuthConfig::required(
        SESSION_SECRET,
        false,
        browser_auth::SessionPolicy::BetterAuth,
    )
    .unwrap();
    let mutation_policy =
        browser_auth::BrowserMutationPolicy::new(&[ALLOWED_ORIGIN.to_owned()]).unwrap();
    let runtime_config = crate::NativeChatPublicRuntime::new(
        host.context().clone(),
        host.paths(),
        std::time::Duration::from_secs(30),
    )
    .unwrap();
    let config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "http://127.0.0.1:1",
        "native-chat-expired-claim-http-key",
    )
    .unwrap()
    .with_browser_auth(browser_auth)
    .unwrap()
    .with_native_chat_mutation_policy(mutation_policy)
    .with_native_chat_runtime(runtime_config);
    let runtime = PublicIngressRuntime::bind(config, Arc::clone(&foundation)).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let stop_server = runtime.control();
    let server_task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let input = serde_json::json!({
        "body":"This accepted input must not be silently resent",
        "clientMutationId":"native-expired-claim-retry-1",
        "modelOverride":null,
        "effortOverride":null,
    });
    let url = format!("{base}/api/chats/{SEND_CHAT}/messages/stream");
    let first = request(
        &client,
        Method::POST,
        url.clone(),
        Some(&signed_session_cookie(&expired_token)),
        Some(ALLOWED_ORIGIN),
        Some(input.clone()),
    )
    .await;
    assert_eq!(first.0, StatusCode::OK);
    let first_events = first
        .1
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(first_events[0]["type"], "ack");
    assert_eq!(first_events[0]["userMessage"]["body"], input["body"]);
    let first_recovery = first_events
        .iter()
        .find(|event| event["error"] == "recovery_required")
        .unwrap();
    assert_eq!(first_recovery["terminal"], false);

    // A second valid browser session for the same user can recover the saved
    // receipt, while the already-created worker retains the expired original
    // principal and is unable to claim. Exact retry must not start another one.
    let retry_token = format!(
        "native-expired-claim-retry-session-{}",
        uuid::Uuid::new_v4()
    );
    let retry_session = format!("native-expired-claim-retry-row-{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at)
         VALUES($1,$2,$3,now()+interval '1 hour',now(),now())",
    )
    .bind(&retry_session)
    .bind(&user_id)
    .bind(&retry_token)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query("DROP TRIGGER test_expire_native_chat_admission_session ON chat_generation_events")
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION test_expire_native_chat_admission_session()")
        .execute(&database.pool)
        .await
        .unwrap();
    let retry = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        request(
            &client,
            Method::POST,
            url,
            Some(&signed_session_cookie(&retry_token)),
            Some(ALLOWED_ORIGIN),
            Some(input),
        ),
    )
    .await
    .expect("exact retry returns a bounded recovery signal");
    assert_eq!(retry.0, StatusCode::OK);
    let retry_events = retry
        .1
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(retry_events[0]["type"], "ack");
    assert!(
        retry_events
            .iter()
            .any(|event| event["error"] == "recovery_required")
    );

    // A freshly authenticated operator can explicitly stop the saved input
    // that never claimed a worker, without provider dispatch or hold leakage.
    let stop_body = serde_json::json!({
        "controlActionId": uuid::Uuid::new_v4().to_string(),
        "expectedGenerationId": retry_events[0]["generationId"],
        "expectedAttemptEpoch": 1,
        "expectedControlVersion": 0,
        "lastCommittedRenderSeq": 0,
        "renderedBodyHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    let stop_url = format!("{base}/api/chats/{SEND_CHAT}/messages/stream/stop");
    for _ in 0..2 {
        let stopped = request(
            &client,
            Method::POST,
            stop_url.clone(),
            Some(&signed_session_cookie(&retry_token)),
            Some(ALLOWED_ORIGIN),
            Some(stop_body.clone()),
        )
        .await;
        assert_eq!(stopped.0, StatusCode::OK);
        let stopped: serde_json::Value = serde_json::from_slice(&stopped.1).unwrap();
        assert_eq!(stopped["stopped"], true);
        assert_eq!(stopped["inputDisposition"], "not_submitted");
    }
    let final_state: (String, String, bool, i64) = sqlx::query_as(
        "SELECT g.status,r.status,g.native_admission_hold OR r.native_admission_hold,
         (SELECT count(*) FROM activity_log WHERE action='runtime.native_chat.stopped_before_claim')
         FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE g.id=$1::uuid"
    ).bind(retry_events[0]["generationId"].as_str().unwrap()).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        final_state,
        ("stopped".into(), "cancelled".into(), false, 1)
    );

    stop_server.stop(true).await;
    server_task.await.unwrap().unwrap();
    worker
        .shutdown(std::time::Duration::from_secs(10))
        .await
        .unwrap();
    assert!(
        host.events().is_empty(),
        "expired original principal cannot launch a provider"
    );
    let admitted_inputs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND role='user' AND client_mutation_id='native-expired-claim-retry-1'",
    )
    .bind(fixture::ORG)
    .bind(SEND_CHAT)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(admitted_inputs, 1);
    database.pool.close().await;
}

#[path = "stop_compatibility_tests.rs"]
mod stop_compatibility_tests;

#[path = "send_compatibility_tests.rs"]
mod send_compatibility_tests;
