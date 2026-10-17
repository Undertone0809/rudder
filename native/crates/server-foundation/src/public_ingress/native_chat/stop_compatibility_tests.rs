//! Compatibility transport regression, not acceptance of Node business logic.
use super::*;
use crate::public_ingress_config::{NativeSessionAuthConfig, NativeSessionAuthKind};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

#[actix_web::test]
#[ignore = "requires PostgreSQL binaries; exact legacy dispatch over disposable data only"]
async fn stop_dispatch_requires_positive_legacy_target_and_signed_current_session() {
    const LEGACY_CHAT: &str = "21000000-0000-4000-8000-000000000402";
    const LEGACY_GENERATION: &str = "61000000-0000-4000-8000-000000000402";
    const ASSERTION_KEY: &str = "native-chat-legacy-stop-assertion-key-fixture";
    let database = fixture::Database::start().await;
    let host = fixture::FixtureHost::new("complete");
    let (actor, run_id, _) = fixture::admitted(&database, &host).await;
    let user_id = actor.actor().id.clone();
    let token = format!("legacy-stop-session-{}", Uuid::new_v4());
    let session_id = format!("legacy-stop-session-row-{}", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
        VALUES($1,'Stop compatibility fixture',$2,now(),now()) ON CONFLICT(id) DO NOTHING",
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
    sqlx::query("INSERT INTO chat_conversations(id,org_id,title,conversation_kind,created_by_user_id,status,preferred_agent_id)
        VALUES($1::uuid,$2::uuid,'Legacy Stop fixture','chat',$3,'active',$4::uuid)")
        .bind(LEGACY_CHAT).bind(fixture::ORG).bind(&user_id).bind(fixture::CEO)
        .execute(&database.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO chat_generations(id,org_id,conversation_id,status)
        VALUES($1::uuid,$2::uuid,$3::uuid,'completed')",
    )
    .bind(LEGACY_GENERATION)
    .bind(fixture::ORG)
    .bind(LEGACY_CHAT)
    .execute(&database.pool)
    .await
    .unwrap();
    let native_generation: String =
        sqlx::query_scalar("SELECT chat_generation_id::text FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&run_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    seed_foreign_native_target(&database.pool, &user_id).await;
    // Rich content currently lacks a public read projection. That limitation
    // must not be confused with writer authority or make Stop undispatchable.
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:test_stop_authority',true)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE chat_messages SET structured_payload='{\"unprojected\":true}'::jsonb
        WHERE id=(SELECT source_message_id FROM chat_generations WHERE id=$1::uuid)",
    )
    .bind(&native_generation)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let native_target = control::ReadTurn {
        conversation_id: fixture::CHAT.into(),
        generation_id: native_generation.clone(),
    };
    assert!(matches!(
        control::read_turn(&database.pool, &actor, &native_target).await,
        Err(PersistenceError::Http(409, _))
    ));
    assert_eq!(
        control::read_stop_target_authority(&database.pool, &actor, &native_target)
            .await
            .unwrap(),
        control::StopTargetAuthority::NativeRust
    );

    let calls = Arc::new(AtomicUsize::new(0));
    let captured = Arc::new(Mutex::new(Vec::<(String, Vec<u8>, String)>::new()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let call_state = calls.clone();
    let capture_state = captured.clone();
    let mock = HttpServer::new(move || {
        let calls = call_state.clone();
        let captured = capture_state.clone();
        App::new().default_service(web::to(move |request: HttpRequest, body: web::Bytes| {
            let calls = calls.clone();
            let captured = captured.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                captured.lock().unwrap().push((
                    request.uri().to_string(),
                    body.to_vec(),
                    request
                        .headers()
                        .get("x-rudder-native-session-proof")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                        .to_owned(),
                ));
                HttpResponse::Ok().json(
                    serde_json::json!({"stopped":false,"disposition":"legacy_transport_fixture"}),
                )
            }
        }))
    })
    .workers(1)
    .disable_signals()
    .listen(listener)
    .unwrap()
    .run();
    let mock_handle = mock.handle();
    let mock_task = actix_web::rt::spawn(mock);
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(format!(
                "postgresql://postgres@127.0.0.1:{}/postgres",
                database.pool.connect_options().get_port()
            )),
            actor_envelope_key: Some(rudder_auth_core::SigningKey::new(AUTH_ENVELOPE_KEY).unwrap()),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "native-chat-legacy-stop-authorization-key",
    )
    .unwrap()
    .with_browser_auth(
        browser_auth::BrowserAuthConfig::required(
            SESSION_SECRET,
            false,
            browser_auth::SessionPolicy::BetterAuth,
        )
        .unwrap(),
    )
    .unwrap()
    .with_native_chat_mutation_policy(
        browser_auth::BrowserMutationPolicy::new(&[ALLOWED_ORIGIN.to_owned()]).unwrap(),
    );
    config.session_auth = Some(
        NativeSessionAuthConfig::new(
            NativeSessionAuthKind::BetterAuth,
            std::str::from_utf8(SESSION_SECRET).unwrap(),
            false,
            ASSERTION_KEY,
        )
        .unwrap(),
    );
    let runtime = PublicIngressRuntime::bind(config, foundation).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let cookie = signed_session_cookie(&token);
    let (cap_status, cap_bytes) = request(
        &client,
        Method::GET,
        format!("{base}/api/native-chat/capabilities"),
        None,
        None,
        None,
    )
    .await;
    assert_eq!(cap_status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&cap_bytes).unwrap(),
        serde_json::json!({
            "executionAuthority":"native_rust", "firstSend":false, "readTurn":true, "nativeControls":true,
        })
    );
    // Full message projection deliberately fails for the seeded rich source;
    // the compact control read must remain available for the same exact turn.
    let (projection_status, _) = request(
        &client,
        Method::GET,
        format!(
            "{base}/api/chats/{}/messages/stream/turn?generationId={native_generation}",
            fixture::CHAT
        ),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(projection_status, StatusCode::CONFLICT);
    let (control_status, control_bytes) = request(
        &client,
        Method::GET,
        format!(
            "{base}/api/chats/{}/messages/stream/control?generationId={native_generation}",
            fixture::CHAT
        ),
        Some(&cookie),
        None,
        None,
    )
    .await;
    assert_eq!(control_status, StatusCode::OK);
    let control_read: serde_json::Value = serde_json::from_slice(&control_bytes).unwrap();
    assert_eq!(control_read["executionAuthority"], "native_rust");
    assert_eq!(control_read["orgId"], fixture::ORG);
    assert_eq!(control_read["conversationId"], fixture::CHAT);
    assert_eq!(control_read["generationId"], native_generation);
    assert_eq!(control_read["attemptEpoch"], 1);
    assert_eq!(control_read["controlVersion"], 0);
    assert_eq!(
        control_read["lastClientCheckpointSeq"],
        serde_json::Value::Null
    );
    assert_eq!(
        control_read["lastClientCheckpointHash"],
        serde_json::Value::Null
    );
    assert_eq!(control_read.as_object().unwrap().len(), 10);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let stop = serde_json::json!({"controlActionId":"81000000-0000-4000-8000-000000000401",
        "expectedGenerationId":LEGACY_GENERATION,"expectedAttemptEpoch":1,"expectedControlVersion":0});
    let legacy_path = format!("/api/chats/{LEGACY_CHAT}/messages/stream/stop");
    for (chat, generation, origin, expected) in [
        (LEGACY_CHAT, LEGACY_GENERATION, None, StatusCode::FORBIDDEN),
        (
            LEGACY_CHAT,
            LEGACY_GENERATION,
            Some("https://foreign.invalid"),
            StatusCode::FORBIDDEN,
        ),
        (
            LEGACY_CHAT,
            FOREIGN_GENERATION,
            Some(ALLOWED_ORIGIN),
            StatusCode::NOT_FOUND,
        ),
        (
            FOREIGN_CHAT,
            FOREIGN_GENERATION,
            Some(ALLOWED_ORIGIN),
            StatusCode::NOT_FOUND,
        ),
        (
            fixture::CHAT,
            native_generation.as_str(),
            Some(ALLOWED_ORIGIN),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let mut body = stop.clone();
        body["expectedGenerationId"] = serde_json::json!(generation);
        let (status, _) = request(
            &client,
            Method::POST,
            format!("{base}/api/chats/{chat}/messages/stream/stop"),
            Some(&cookie),
            origin,
            Some(body),
        )
        .await;
        assert_eq!(status, expected);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "rejected or Native targets must never reach compatibility transport"
        );
    }
    let (native_status, _) = request(&client, Method::POST,
        format!("{base}/api/chats/{}/messages/stream/stop", fixture::CHAT), Some(&cookie),
        Some(ALLOWED_ORIGIN), Some(serde_json::json!({
            "controlActionId":"81000000-0000-4000-8000-000000000402", "expectedGenerationId":native_generation,
            "expectedAttemptEpoch":1, "expectedControlVersion":999,
            "lastCommittedRenderSeq":0, "renderedBodyHash":format!("{:x}", Sha256::digest(b"")),
        }))).await;
    assert_eq!(native_status, StatusCode::CONFLICT);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "failed Native controls cannot select the legacy handler"
    );
    let (status, bytes) = request(
        &client,
        Method::POST,
        format!("{base}{legacy_path}"),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(stop.clone()),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    {
        let captured = captured.lock().unwrap();
        let (path, body, proof) = &captured[0];
        assert_eq!(path, &legacy_path);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(body).unwrap(),
            stop
        );
        let (payload, signature) = proof
            .split_once('.')
            .expect("Rust-issued session assertion");
        let mut mac = Hmac::<Sha256>::new_from_slice(ASSERTION_KEY.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        mac.verify_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(signature)
                .unwrap(),
        )
        .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["method"], "POST");
        assert_eq!(payload["target"], legacy_path);
        assert_eq!(payload["identity"]["user_id"], user_id);
        assert_eq!(payload["identity"]["session_id"], session_id);
    }
    sqlx::query("UPDATE session SET expires_at=now()-interval '1 hour' WHERE id=$1")
        .bind(&session_id)
        .execute(&database.pool)
        .await
        .unwrap();
    let (expired_status, _) = request(
        &client,
        Method::POST,
        format!("{base}{legacy_path}"),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(stop),
    )
    .await;
    assert_eq!(expired_status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "expired sessions must not reach the legacy handler"
    );
    control.stop(false).await;
    task.await.unwrap().unwrap();
    mock_handle.stop(false).await;
    mock_task.await.unwrap().unwrap();
}
