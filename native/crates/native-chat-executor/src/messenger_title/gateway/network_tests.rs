//! Real loopback protocol peers: no Node backend, provider service or database.
use super::*;
use crate::messenger_title::Workspace;
use actix_codec::Framed;
use actix_http::ws::{Codec, Frame, Message};
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{SinkExt, StreamExt, stream};
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use std::{
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

const PROMPT: &str = "Name this actual discussion, not a generic wake.\n下周发布计划";
const TOKEN: &str = "synthetic-gateway-token";
const NONCE: &str = "network-challenge-nonce";

fn request() -> Request {
    let workspace = Workspace::create().unwrap();
    let cwd = workspace.path().to_path_buf();
    Request {
        workspace_guard: workspace,
        org_id: uuid::Uuid::new_v4().to_string(),
        run_id: format!("title-network-{}", uuid::Uuid::new_v4()),
        prompt: PROMPT.into(),
        runtime_root: cwd.clone(),
        env: BTreeMap::from([("HOME".into(), cwd.to_string_lossy().into_owned())]),
        cwd,
        process_host: PathBuf::new(),
        cancelled: Arc::new(AtomicBool::new(false)),
    }
}

struct HttpCall {
    method: String,
    path: String,
    authorization: String,
    session_key: Option<String>,
    marker: String,
    body: Value,
}
struct HermesPeer {
    calls: Mutex<Vec<HttpCall>>,
    cancellation: Arc<AtomicBool>,
    cancel: bool,
}
async fn hermes_http(
    peer: web::Data<HermesPeer>,
    request: HttpRequest,
    body: web::Bytes,
) -> HttpResponse {
    let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned()
    };
    peer.calls.lock().unwrap().push(HttpCall {
        method: request.method().to_string(),
        path: request.uri().path().to_owned(),
        authorization: header("authorization"),
        session_key: request
            .headers()
            .get("x-hermes-session-key")
            .map(|v| v.to_str().unwrap().to_owned()),
        marker: header("x-network-fixture"),
        body: value,
    });
    match (request.method().as_str(), request.uri().path()) {
        ("POST", "/fixture/api/sessions") => {
            HttpResponse::Ok().json(json!({"session":{"id":"provider session/one"}}))
        }
        ("GET", "/fixture/api/sessions/provider%20session%2Fone/messages") => {
            HttpResponse::Ok().json(json!({"session_id":"provider session/one","messages":[]}))
        }
        ("POST", "/fixture/v1/runs") => {
            HttpResponse::Ok().json(json!({"run_id":"provider-run","status":"running"}))
        }
        ("GET", "/fixture/v1/runs/provider-run/events") if peer.cancel => {
            peer.cancellation.store(true, Ordering::Release);
            let first = stream::once(async {
                Ok::<_, actix_web::Error>(web::Bytes::from_static(b": alive\n\n"))
            });
            HttpResponse::Ok()
                .content_type("text/event-stream")
                .streaming(first.chain(stream::pending()))
        }
        ("GET", "/fixture/v1/runs/provider-run/events") => HttpResponse::Ok()
            .content_type("text/event-stream")
            .body(concat!(
                "data: {\"event\":\"message.delta\",\"delta\":\"Team \"}\n\n",
                "data: {\"event\":\"message.delta\",\"delta\":\"ship\"}\n\n",
                "data: {\"event\":\"run.completed\",\"text\":\"wrong terminal fallback\"}\n\n"
            )),
        ("POST", "/fixture/v1/runs/provider-run/stop") if peer.cancel => {
            HttpResponse::Ok().json(json!({"status":"stopping"}))
        }
        ("GET", "/fixture/v1/runs/provider-run") if peer.cancel => {
            HttpResponse::Ok().json(json!({"status":"cancelled"}))
        }
        _ => HttpResponse::InternalServerError().json(json!({"error":"unexpected extra request"})),
    }
}
async fn hermes_case(cancel: bool) {
    let request = request();
    let peer = Arc::new(HermesPeer {
        calls: Mutex::new(Vec::new()),
        cancellation: request.cancelled.clone(),
        cancel,
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = HttpServer::new({
        let peer = peer.clone();
        move || {
            App::new()
                .app_data(web::Data::from(peer.clone()))
                .default_service(web::to(hermes_http))
        }
    })
    .workers(1)
    .shutdown_timeout(1)
    .listen(listener)
    .unwrap()
    .run();
    let control = server.handle();
    let task = actix_web::rt::spawn(server);
    let config = json!({"url":format!("http://{address}/fixture"),"apiKey":TOKEN,
        "model":"synthetic-model","timeoutMs":2000,"headers":{"x-network-fixture":"hermes"},
        "payloadTemplate":{"input":"stale input","message":"generic wake","temperature":0.2}});
    let result = timeout(
        Duration::from_secs(5),
        execute("hermes_gateway", &config, &request),
    )
    .await;
    timeout(Duration::from_secs(2), control.stop(false))
        .await
        .unwrap();
    timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let result = result.expect("Hermes protocol must finish within its finite test budget");
    if cancel {
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "stop must prove cancellation"
        );
    } else {
        let output = result.unwrap();
        assert!(output.success);
        assert_eq!(
            output.text, "Team ship",
            "SSE delta boundary spaces must survive"
        );
    }
    let calls = peer.calls.lock().unwrap();
    let mut expected = vec![
        ("POST", "/fixture/api/sessions"),
        (
            "GET",
            "/fixture/api/sessions/provider%20session%2Fone/messages",
        ),
        ("POST", "/fixture/v1/runs"),
        ("GET", "/fixture/v1/runs/provider-run/events"),
    ];
    if cancel {
        expected.extend([
            ("POST", "/fixture/v1/runs/provider-run/stop"),
            ("GET", "/fixture/v1/runs/provider-run"),
        ]);
    }
    assert_eq!(
        calls
            .iter()
            .map(|c| (c.method.as_str(), c.path.as_str()))
            .collect::<Vec<_>>(),
        expected,
        "SSE terminal must not poll; cancellation must poll the stop terminal"
    );
    assert!(
        calls
            .iter()
            .all(|c| c.authorization == format!("Bearer {TOKEN}") && c.marker == "hermes")
    );
    assert_eq!(
        calls[0].body,
        json!({"source":"rudder","model":"synthetic-model"})
    );
    assert_eq!(
        calls[2].body,
        json!({"input":PROMPT,"session_id":"provider session/one",
        "idempotency_key":request.run_id,"model":"synthetic-model","temperature":0.2})
    );
    assert_eq!(
        calls[2].session_key.as_deref(),
        Some(format!("rudder:run:{}", request.run_id).as_str())
    );
    if cancel {
        assert_eq!(calls[4].body, json!({"reason":"rudder_abort"}));
    }
}

#[actix_web::test]
async fn hermes_sends_the_actual_prompt_and_keeps_sse_delta_spaces_without_terminal_poll() {
    hermes_case(false).await;
}
#[actix_web::test]
async fn hermes_cancellation_stops_the_real_run_and_observes_its_terminal() {
    hermes_case(true).await;
}

type Ws = Framed<TcpStream, Codec>;
async fn websocket(listener: tokio::net::TcpListener) -> Ws {
    let (mut socket, _) = timeout(Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    // Read only the HTTP header, leaving any first WebSocket frame in the socket.
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 16 * 1024);
        bytes.push(
            timeout(Duration::from_secs(3), socket.read_u8())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    let request = String::from_utf8(bytes).unwrap();
    assert!(request.starts_with("GET /gateway HTTP/1.1\r\n"));
    let headers: BTreeMap<_, _> = request
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    assert_eq!(headers["authorization"], format!("Bearer {TOKEN}"));
    assert_eq!(headers["x-network-fixture"], "openclaw");
    assert_eq!(headers["upgrade"].to_ascii_lowercase(), "websocket");
    assert_eq!(headers["sec-websocket-version"], "13");
    let accept = actix_http::ws::hash_key(headers["sec-websocket-key"].as_bytes());
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        std::str::from_utf8(&accept).unwrap()
    );
    socket.write_all(response.as_bytes()).await.unwrap();
    Framed::new(socket, Codec::new())
}
async fn send(socket: &mut Ws, value: Value) {
    timeout(
        Duration::from_secs(3),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await
    .unwrap()
    .unwrap();
}
async fn receive(socket: &mut Ws, method: &str) -> Value {
    let frame = timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Frame::Text(bytes) = frame else {
        panic!("expected JSON request, received {frame:?}")
    };
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["type"], "req");
    assert_eq!(value["method"], method);
    assert!(!value["id"].as_str().unwrap().is_empty());
    value
}
async fn reply(socket: &mut Ws, request: &Value, payload: Value) {
    send(
        socket,
        json!({"type":"res","id":request["id"],"ok":true,"payload":payload}),
    )
    .await;
}
async fn closed(socket: &mut Ws) {
    let frame = timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Frame::Close(Some(reason)) = frame else {
        panic!("expected finite Close, received {frame:?}")
    };
    assert_eq!(reason.code, actix_http::ws::CloseCode::Normal);
    assert_eq!(reason.description.as_deref(), Some("rudder-complete"));
}
fn openclaw_config(address: std::net::SocketAddr, role: &str) -> Value {
    // Fixed synthetic PKCS8 V1 seed, independent of the implementation's signer.
    let mut key = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    key.extend_from_slice(&[17; 32]);
    json!({"url":format!("ws://{address}/gateway"),"authToken":TOKEN,"role":role,
        "clientId":"network-title-client","clientVersion":"fixture","clientMode":"backend",
        "deviceFamily":"fixture","sessionKey":"title-fixture","sessionKeyStrategy":"run",
        "agentId":"title-agent","model":"configured-model","timeoutSec":2,"waitTimeoutMs":1000,
        "headers":{"x-network-fixture":"openclaw"},
        "devicePrivateKeyPem":format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----", STANDARD.encode(key)),
        "payloadTemplate":{"message":"Pinned introduction","model":"template-model","provider":"template-provider"}})
}
async fn connect(socket: &mut Ws, role: &str) {
    send(
        socket,
        json!({"type":"event","event":"connect.challenge","payload":{"nonce":NONCE}}),
    )
    .await;
    let request = receive(socket, "connect").await;
    let params = &request["params"];
    assert_eq!(params["minProtocol"], 4);
    assert_eq!(params["maxProtocol"], 4);
    assert_eq!(params["client"]["id"], "network-title-client");
    assert_eq!(params["client"]["version"], "fixture");
    assert_eq!(params["client"]["mode"], "backend");
    assert_eq!(params["client"]["deviceFamily"], "fixture");
    assert_eq!(params["role"], role);
    assert_eq!(params["scopes"], json!(["operator.read", "operator.write"]));
    assert_eq!(params["auth"], json!({"token":TOKEN}));
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        std::env::consts::OS
    };
    assert_eq!(params["client"]["platform"], platform);
    let device = &params["device"];
    let public = URL_SAFE_NO_PAD
        .decode(device["publicKey"].as_str().unwrap())
        .unwrap();
    let expected_key = Ed25519KeyPair::from_seed_unchecked(&[17; 32]).unwrap();
    assert_eq!(public, expected_key.public_key().as_ref());
    let id: String = ring::digest::digest(&ring::digest::SHA256, &public)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(device["id"], id);
    assert_eq!(device["nonce"], NONCE);
    let signed_at = device["signedAt"].as_u64().unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    assert!(now.abs_diff(u128::from(signed_at)) < 5000);
    // Verify the actual received wire signature, never the production payload helper.
    let signed = format!(
        "v3|{id}|network-title-client|backend|{role}|operator.read,operator.write|{signed_at}|{TOKEN}|{NONCE}|{platform}|fixture"
    );
    UnparsedPublicKey::new(&ED25519, public)
        .verify(
            signed.as_bytes(),
            &URL_SAFE_NO_PAD
                .decode(device["signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
    reply(socket, &request, json!({"type":"hello-ok","protocol":4})).await;
}
fn check_agent(request: &Value, run: &str, role: &str) {
    let params = &request["params"];
    assert_eq!(
        params["message"],
        format!("Pinned introduction\n\n{PROMPT}")
    );
    assert!(params.get("text").is_none());
    assert_eq!(
        params["sessionKey"],
        format!("agent:title-agent:rudder:run:{run}")
    );
    assert_eq!(params["agentId"], "title-agent");
    assert_eq!(params["idempotencyKey"], run);
    assert_eq!(params["timeout"], 1000);
    if role == "admin" {
        assert_eq!(params["model"], "template-model");
        assert_eq!(params["provider"], "template-provider");
    } else {
        assert!(params.get("model").is_none());
        assert!(params.get("provider").is_none());
    }
}

#[actix_web::test]
async fn openclaw_v4_signs_the_challenge_and_sends_prompt_with_role_scoped_models_and_close() {
    for role in ["operator", "admin"] {
        let request = request();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = openclaw_config(listener.local_addr().unwrap(), role);
        let run = request.run_id.clone();
        let peer = actix_web::rt::spawn(async move {
            let mut socket = websocket(listener).await;
            connect(&mut socket, role).await;
            let agent = receive(&mut socket, "agent").await;
            check_agent(&agent, &run, role);
            reply(
                &mut socket,
                &agent,
                json!({"runId":"provider-title-run","status":"accepted"}),
            )
            .await;
            let wait = receive(&mut socket, "agent.wait").await;
            assert_eq!(
                wait["params"],
                json!({"runId":"provider-title-run","timeoutMs":1000})
            );
            for (run, delta) in [
                ("unrelated-run", "injected text"),
                ("provider-title-run", "Team "),
                ("provider-title-run", "ship"),
            ] {
                send(&mut socket, json!({"type":"event","event":"agent","payload":{"runId":run,"stream":"assistant","data":{"delta":delta}}})).await;
            }
            reply(
                &mut socket,
                &wait,
                json!({"status":"ok","text":"wrong terminal fallback"}),
            )
            .await;
            closed(&mut socket).await;
        });
        let result = timeout(
            Duration::from_secs(6),
            execute("openclaw_gateway", &config, &request),
        )
        .await;
        timeout(Duration::from_secs(4), peer)
            .await
            .unwrap()
            .unwrap();
        let output = result.unwrap().unwrap();
        assert!(output.success);
        assert_eq!(output.text, "Team ship");
    }
}

#[actix_web::test]
async fn openclaw_cancel_aborts_the_provider_run_and_bounds_unproven_cleanup() {
    for reject_abort in [false, true] {
        let request = request();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = openclaw_config(listener.local_addr().unwrap(), "operator");
        let run = request.run_id.clone();
        let cancellation = request.cancelled.clone();
        let peer = actix_web::rt::spawn(async move {
            let mut socket = websocket(listener).await;
            connect(&mut socket, "operator").await;
            let agent = receive(&mut socket, "agent").await;
            check_agent(&agent, &run, "operator");
            reply(
                &mut socket,
                &agent,
                json!({"runId":"provider-title-run","status":"accepted"}),
            )
            .await;
            let wait = receive(&mut socket, "agent.wait").await;
            assert_eq!(wait["params"]["runId"], "provider-title-run");
            cancellation.store(true, Ordering::Release);
            let abort = receive(&mut socket, "sessions.abort").await;
            assert_eq!(abort["params"], json!({"runId":"provider-title-run"}));
            if reject_abort {
                send(&mut socket, json!({"type":"res","id":abort["id"],"ok":false,"error":{"message":"synthetic abort refusal"}})).await;
                let fallback = receive(&mut socket, "chat.abort").await;
                assert_eq!(
                    fallback["params"],
                    json!({"sessionKey":format!("agent:title-agent:rudder:run:{run}"),"runId":"provider-title-run"})
                );
                send(&mut socket, json!({"type":"res","id":fallback["id"],"ok":false,"error":{"message":"synthetic abort refusal"}})).await;
            } else {
                reply(&mut socket, &abort, json!({"aborted":true})).await;
            }
            closed(&mut socket).await;
        });
        let result = timeout(
            Duration::from_secs(6),
            execute("openclaw_gateway", &config, &request),
        )
        .await;
        timeout(Duration::from_secs(4), peer)
            .await
            .unwrap()
            .unwrap();
        let result = result.expect("cancellation/cleanup must terminate within the finite budget");
        if reject_abort {
            assert!(matches!(result, Err(Error::Cleanup)));
        } else {
            assert!(matches!(result, Err(Error::Cancelled)));
        }
    }
}
