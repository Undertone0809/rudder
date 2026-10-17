//! Real Rust ingress / PostgreSQL dispatch tests. The loopback mock is only a
//! transport sentinel: it proves the existing signed compatibility adapter
//! receives the exact request bytes and is never selected for Native targets.

use super::*;
use crate::public_ingress_config::{NativeSessionAuthConfig, NativeSessionAuthKind};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

const ASSERTION_KEY: &str = "native-chat-legacy-send-assertion-key-fixture";
const LEGACY_AGENT: &str = "50000000-0000-4000-8000-000000000991";
const FOREIGN_AGENT: &str = "50000000-0000-4000-8000-000000000992";
const LEGACY_CHAT: &str = "21000000-0000-4000-8000-000000000991";

#[actix_web::test]
#[ignore = "requires PostgreSQL binaries and a synthetic provider fixture; compatibility transport only"]
async fn send_dispatch_preserves_legacy_bytes_and_never_falls_back_from_native_or_unknown() {
    let database = fixture::Database::start().await;
    let host = fixture::FixtureHost::new("complete");
    let (actor, _, _) = fixture::admitted(&database, &host).await;
    let user_id = actor.actor().id.clone();
    let token = format!("legacy-send-session-{}", Uuid::new_v4());
    let session_id = format!("legacy-send-session-row-{}", Uuid::new_v4());
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
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type)
         VALUES($1::uuid,$2::uuid,'Legacy send Agent','general','idle','process')",
    )
    .bind(LEGACY_AGENT)
    .bind(fixture::ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO chat_conversations
           (id,org_id,title,conversation_kind,created_by_user_id,status,preferred_agent_id)
         VALUES($1::uuid,$2::uuid,'Legacy send target','chat',$3,'active',$4::uuid)",
    )
    .bind(LEGACY_CHAT)
    .bind(fixture::ORG)
    .bind(&user_id)
    .bind(LEGACY_AGENT)
    .execute(&database.pool)
    .await
    .unwrap();

    let calls = Arc::new(AtomicUsize::new(0));
    let captured = Arc::new(Mutex::new(Vec::<(String, Vec<u8>, String, String)>::new()));
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
                    request
                        .headers()
                        .get(header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                        .to_owned(),
                ));
                HttpResponse::Ok().json(serde_json::json!({"transport":"captured"}))
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
    let mut config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "native-chat-legacy-send-authorization-key",
    )
    .unwrap()
    .with_browser_auth(browser_auth)
    .unwrap()
    .with_native_chat_mutation_policy(mutation_policy);
    config.session_auth = Some(
        NativeSessionAuthConfig::new(
            NativeSessionAuthKind::BetterAuth,
            std::str::from_utf8(SESSION_SECRET).unwrap(),
            false,
            ASSERTION_KEY,
        )
        .unwrap(),
    );
    let runtime =
        PublicIngressRuntime::bind(config.with_native_chat_runtime(runtime_config), foundation)
            .unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let ingress_handle = runtime.control();
    let ingress_task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let cookie = signed_session_cookie(&token);

    let legacy_existing_path = format!("/api/chats/{LEGACY_CHAT}/messages/stream");
    let legacy_existing_body = serde_json::json!({
        "body":"Legacy existing input",
        "clientMutationId":"legacy-existing-input",
        "modelOverride":"legacy-model",
        "inlineAnnotations":[{"type":"text","text":"preserve"}],
    });
    let (existing_status, _) = request(
        &client,
        Method::POST,
        format!("{base}{legacy_existing_path}"),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(legacy_existing_body.clone()),
    )
    .await;
    assert_eq!(existing_status, StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let legacy_first_path = format!("/api/orgs/{}/chats/messages/stream", fixture::ORG);
    let legacy_first_body = serde_json::json!({
        "body":"Legacy first input",
        "clientMutationId":"legacy-first-input",
        "preferredAgentId":LEGACY_AGENT,
        "planMode":true,
        "contextLinks":[{"kind":"url","url":"https://example.invalid/context"}],
    });
    let (first_status, _) = request(
        &client,
        Method::POST,
        format!("{base}{legacy_first_path}"),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(legacy_first_body.clone()),
    )
    .await;
    assert_eq!(first_status, StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let multipart_boundary = "----rudder-legacy-send-boundary";
    let multipart_content_type = format!("multipart/form-data; boundary={multipart_boundary}");
    let multipart_body = format!(
        "--{multipart_boundary}\r\n\
         Content-Disposition: form-data; name=\"body\"\r\n\r\n\
         Legacy multipart first input\r\n\
         --{multipart_boundary}\r\n\
         Content-Disposition: form-data; name=\"clientMutationId\"\r\n\r\n\
         legacy-multipart-input\r\n\
         --{multipart_boundary}\r\n\
         Content-Disposition: form-data; name=\"preferredAgentId\"\r\n\r\n\
         {LEGACY_AGENT}\r\n\
         --{multipart_boundary}\r\n\
         Content-Disposition: form-data; name=\"files\"; filename=\"note.txt\"\r\n\
         Content-Type: text/plain\r\n\r\n\
         payload with a boundary-like marker \r\n--{multipart_boundary}x\r\n\
         --{multipart_boundary}--\r\n"
    )
    .into_bytes();
    let mut multipart_response = client
        .post(format!("{base}{legacy_first_path}"))
        .insert_header((header::COOKIE, cookie.as_str()))
        .insert_header((header::ORIGIN, ALLOWED_ORIGIN))
        .insert_header((header::CONTENT_TYPE, multipart_content_type.as_str()))
        .send_body(multipart_body.clone())
        .await
        .unwrap();
    assert_eq!(multipart_response.status(), StatusCode::OK);
    let _ = multipart_response.body().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    // A Native target remains on the Native route even when its strict input
    // parser rejects legacy-only fields. Such an error must never trigger Node.
    let native_body = serde_json::json!({
        "body":"Do not fall back",
        "clientMutationId":"native-unsupported-input",
        "inlineAnnotations":[{"type":"text","text":"not supported here"}],
    });
    let (native_status, _) = request(
        &client,
        Method::POST,
        format!("{base}/api/chats/{}/messages/stream", fixture::CHAT),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(native_body),
    )
    .await;
    assert_eq!(native_status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    let native_multipart_body = format!(
        "--{multipart_boundary}\r\n\
         Content-Disposition: form-data; name=\"body\"\r\n\r\n\
         Native multipart remains unsupported\r\n\
         --{multipart_boundary}\r\n\
         Content-Disposition: form-data; name=\"preferredAgentId\"\r\n\r\n\
         {}\r\n\
         --{multipart_boundary}--\r\n",
        fixture::CEO
    )
    .into_bytes();
    let mut native_multipart_response = client
        .post(format!(
            "{base}/api/orgs/{}/chats/messages/stream",
            fixture::ORG
        ))
        .insert_header((header::COOKIE, cookie.as_str()))
        .insert_header((header::ORIGIN, ALLOWED_ORIGIN))
        .insert_header((header::CONTENT_TYPE, multipart_content_type.as_str()))
        .send_body(native_multipart_body)
        .await
        .unwrap();
    assert_eq!(
        native_multipart_response.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let _ = native_multipart_response.body().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    // Unknown runtime identity and cross-organization Agent hints fail closed.
    sqlx::query("UPDATE agents SET agent_runtime_type='future_runtime' WHERE id=$1::uuid")
        .bind(LEGACY_AGENT)
        .execute(&database.pool)
        .await
        .unwrap();
    let (unknown_status, _) = request(
        &client,
        Method::POST,
        format!("{base}{legacy_existing_path}"),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(serde_json::json!({
            "body":"unknown must not proxy",
            "clientMutationId":"unknown-runtime",
        })),
    )
    .await;
    assert_eq!(unknown_status, StatusCode::CONFLICT);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    let (foreign_agent_status, _) = request(
        &client,
        Method::POST,
        format!("{base}{legacy_first_path}"),
        Some(&cookie),
        Some(ALLOWED_ORIGIN),
        Some(serde_json::json!({
            "body":"foreign Agent must not proxy",
            "clientMutationId":"foreign-agent-first",
            "preferredAgentId":FOREIGN_AGENT,
            "planMode":true,
        })),
    )
    .await;
    assert_eq!(foreign_agent_status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    let captured = captured.lock().unwrap().clone();
    assert_eq!(captured.len(), 3);
    for (index, (path, bytes, proof, content_type)) in captured.iter().enumerate() {
        let expected_path = if index == 0 {
            legacy_existing_path.as_str()
        } else {
            legacy_first_path.as_str()
        };
        let expected_body = if index == 0 {
            serde_json::to_vec(&legacy_existing_body).unwrap()
        } else if index == 1 {
            serde_json::to_vec(&legacy_first_body).unwrap()
        } else {
            multipart_body.clone()
        };
        assert_eq!(path, expected_path);
        assert_eq!(
            bytes, &expected_body,
            "compatibility body must be unchanged"
        );
        if index == 2 {
            assert_eq!(content_type, &multipart_content_type);
        }
        let (payload, signature) = proof.split_once('.').expect("signed session proof");
        let mut mac = Hmac::<Sha256>::new_from_slice(ASSERTION_KEY.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        mac.verify_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(signature)
                .unwrap(),
        )
        .unwrap();
        let claim: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claim["method"], "POST");
        assert_eq!(claim["target"], expected_path);
        assert_eq!(claim["identity"]["user_id"], user_id);
        assert_eq!(claim["identity"]["session_id"], session_id);
    }
    drop(captured);

    ingress_handle.stop(false).await;
    ingress_task.await.unwrap().unwrap();
    mock_handle.stop(false).await;
    mock_task.await.unwrap().unwrap();
}
