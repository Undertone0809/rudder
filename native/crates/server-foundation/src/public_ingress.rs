//! Public listener with a direct Rust read and an explicit unmigrated proxy.
//! The private foundation router is deliberately not mounted on this socket.

use super::*;
use crate::llm_reflection::{LlmReflectionDocument, LlmReflectionSnapshot};
use crate::public_ingress_proxy::{PRIVATE_LLM_REFLECTION_AUTH_ADAPTER_PATH, PublicIngressProxy};
use crate::public_ingress_websocket::PublicIngressWebSocketProxy;
use actix_web::guard;
use uuid::Uuid;

const AUTH_PATH: &str = "/api/_internal/rudder-ingress/authorize-member-directory";
const LLM_REFLECTION_AUTH_PATH: &str = PRIVATE_LLM_REFLECTION_AUTH_ADAPTER_PATH;
const LLM_REFLECTION_ACTION: &str = "llm.reflection.read";
const LLM_REFLECTION_SCOPE: &str = "instance";

#[derive(Clone)]
struct IngressState {
    foundation: Arc<AppState>,
    config: PublicIngressConfig,
}

pub struct PublicIngressRuntime {
    server: actix_web::dev::Server,
    handle: actix_web::dev::ServerHandle,
    bound_addr: SocketAddr,
}

impl PublicIngressRuntime {
    pub(crate) fn bind(
        config: PublicIngressConfig,
        foundation: Arc<AppState>,
    ) -> Result<Self, ServerError> {
        if foundation.config.actor_envelope_key.is_none() {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_ACTOR_ENVELOPE_KEY",
                "public ingress requires signed authorization",
            )
            .into());
        }
        let listen_addr = config.listen_addr;
        let data = web::Data::new(IngressState {
            foundation: foundation.clone(),
            config: config.clone(),
        });
        let http = HttpServer::new(move || {
            // Client state belongs to its Actix worker; no Send/Sync workaround.
            let proxy = PublicIngressProxy::new(&config.node_upstream)
                .expect("validated fixed loopback upstream")
                .with_forwarding_policy(config.forwarding_policy.clone());
            let websocket_proxy = PublicIngressWebSocketProxy::new(proxy.upstream_authority())
                .expect("validated fixed loopback upstream")
                .with_forwarding_policy(config.forwarding_policy.clone());
            App::new()
                .app_data(data.clone())
                .app_data(web::Data::new(proxy))
                .app_data(web::Data::new(websocket_proxy))
                .route("/healthz", web::get().to(ingress_health))
                .route("/readyz", web::get().to(ingress_readiness))
                .route(
                    "/api/orgs/{org_id}/members/directory",
                    web::get().to(member_directory),
                )
                .route(
                    "/llms/agent-configuration.txt",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(llm_configuration_index),
                )
                .route(
                    "/llms/agent-icons.txt",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(llm_agent_icons),
                )
                .route(
                    "/llms/agent-configuration/{adapter_file:[^/]+\\.txt}",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(llm_adapter_configuration),
                )
                .default_service(web::to(proxy_request))
        })
        .workers(foundation.config.workers)
        .disable_signals()
        .shutdown_timeout(foundation.config.shutdown_grace.as_secs())
        .bind(listen_addr)?;
        let bound_addr = *http.addrs().first().ok_or(ServerError::NoBoundAddress)?;
        let server = http.run();
        Ok(Self {
            handle: server.handle(),
            server,
            bound_addr,
        })
    }

    pub fn bound_addr(&self) -> SocketAddr {
        self.bound_addr
    }
    pub fn control(&self) -> actix_web::dev::ServerHandle {
        self.handle.clone()
    }
    pub async fn run(self) -> std::io::Result<()> {
        self.server.await
    }
}

async fn ingress_health(state: web::Data<IngressState>) -> HttpResponse {
    state.foundation.health()
}

async fn ingress_readiness(state: web::Data<IngressState>, request: HttpRequest) -> HttpResponse {
    let database = state.foundation.readiness().await;
    if !database.status().is_success() {
        return database;
    }
    let client = awc::Client::builder()
        .disable_redirects()
        .timeout(Duration::from_secs(3))
        .finish();
    let mut probe = client.get(format!("{}/api/health", state.config.node_upstream));
    if let Some(host) = request.headers().get(header::HOST) {
        probe = probe.insert_header((header::HOST, host.clone()));
    }
    match probe.send().await {
        Ok(response) if response.status().is_success() => database,
        _ => state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "private_node_not_ready"),
    }
}

async fn proxy_request(
    state: web::Data<IngressState>,
    proxy: web::Data<PublicIngressProxy>,
    websocket_proxy: web::Data<PublicIngressWebSocketProxy>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    // Express's compatibility router is case-insensitive and accepts an
    // optional trailing slash. Never let a near-match under this namespace
    // fall back to Node in required-Rust mode: exact migrated routes are
    // handled above, and every remaining /llms path is deliberately closed.
    if request
        .uri()
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .is_some_and(|segment| segment.eq_ignore_ascii_case("llms"))
    {
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    }

    if request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("websocket"))
    {
        return websocket_proxy.forward(request, payload).await;
    }
    proxy.forward(request, payload).await
}

async fn member_directory(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
    query: web::Query<MemberDirectoryQuery>,
) -> HttpResponse {
    if !body.is_empty() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "member_directory_body_not_allowed");
    }
    let identity = match state.config.forwarding_policy.identity(&request) {
        Ok(identity) => identity,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
        }
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let request_id = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();
    let public_path = request.uri().to_string();
    let client = awc::Client::builder()
        .disable_redirects()
        .timeout(Duration::from_secs(3))
        .finish();
    let mut auth = client
        .get(format!("{}{}", state.config.node_upstream, AUTH_PATH))
        .insert_header((
            "x-rudder-ingress-auth",
            state.config.authorization_key.as_str(),
        ));
    // Keep the public read method: POST would activate write-only CLI agent
    // fences in Node auth and reject credentials accepted by the original GET.
    // The bounded JSON body is a private fixed-loopback transport contract.
    // Signed run context validation and organization scope still apply.
    // Never forward a client signed envelope, forwarding assertion or key.
    for name in [
        "host",
        "origin",
        "cookie",
        "authorization",
        "x-rudder-agent-id",
        "x-rudder-run-id",
    ] {
        if let Some(value) = request.headers().get(name) {
            auth = auth.insert_header((name, value.clone()));
        }
    }
    auth = auth
        .insert_header(("x-forwarded-for", identity.client_ip.as_str()))
        .insert_header(("x-real-ip", identity.client_ip.as_str()))
        .insert_header(("x-forwarded-proto", identity.scheme));
    let mut response = match auth
        .send_json(&serde_json::json!({
            "organizationId": org_id.as_str(), "publicPath": public_path,
            "requestId": request_id, "nonce": nonce,
        }))
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ingress_authorization_unavailable",
            );
        }
    };
    if !response.status().is_success() {
        let status = match response.status().as_u16() {
            401 => StatusCode::UNAUTHORIZED,
            403 => StatusCode::FORBIDDEN,
            _ => StatusCode::SERVICE_UNAVAILABLE,
        };
        return state
            .foundation
            .json_error(status, "ingress_authorization_rejected");
    }
    let signed: serde_json::Value =
        match response.json::<serde_json::Value>().limit(32 * 1024).await {
            Ok(signed) => signed,
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "ingress_authorization_invalid",
                );
            }
        };
    let envelope: ActorEnvelope = match serde_json::from_value(signed) {
        Ok(envelope) => envelope,
        Err(_) => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ingress_authorization_invalid",
            );
        }
    };
    let key = state
        .foundation
        .config
        .actor_envelope_key
        .as_ref()
        .expect("checked before bind");
    if envelope.nonce != nonce {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ingress_authorization_invalid",
        );
    }
    if state
        .foundation
        .verify_actor_envelope_parts(
            key,
            &envelope,
            &request,
            org_id.as_str(),
            MEMBER_DIRECTORY_ACTION,
            None,
            b"",
            &request_id,
        )
        .is_err()
    {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ingress_authorization_invalid",
        );
    }
    state
        .foundation
        .organization_member_directory_authorized(org_id.as_str(), query.into_inner())
        .await
}

#[derive(Deserialize)]
struct LlmReflectionAuthorizationResponse {
    envelope: ActorEnvelope,
    reflection: LlmReflectionSnapshot,
}

async fn llm_configuration_index(
    state: web::Data<IngressState>,
    request: HttpRequest,
) -> HttpResponse {
    llm_reflection(state, request, LlmReflectionDocument::Index).await
}

async fn llm_agent_icons(state: web::Data<IngressState>, request: HttpRequest) -> HttpResponse {
    llm_reflection(state, request, LlmReflectionDocument::Icons).await
}

async fn llm_adapter_configuration(
    state: web::Data<IngressState>,
    request: HttpRequest,
) -> HttpResponse {
    let Some(raw_adapter_type) = request
        .uri()
        .path()
        .strip_prefix("/llms/agent-configuration/")
        .and_then(|file| file.strip_suffix(".txt"))
    else {
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    };
    let adapter_type = match percent_encoding::percent_decode_str(raw_adapter_type).decode_utf8() {
        Ok(adapter_type) => adapter_type.into_owned(),
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::NOT_FOUND, "route_not_found");
        }
    };
    if adapter_type.is_empty() {
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    }
    llm_reflection(
        state,
        request,
        LlmReflectionDocument::Adapter(&adapter_type),
    )
    .await
}

async fn llm_reflection(
    state: web::Data<IngressState>,
    request: HttpRequest,
    document: LlmReflectionDocument<'_>,
) -> HttpResponse {
    let identity = match state.config.forwarding_policy.identity(&request) {
        Ok(identity) => identity,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
        }
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };

    let request_id = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();
    let public_path = request.uri().to_string();
    let public_method = request.method().as_str();
    let client = awc::Client::builder()
        .disable_redirects()
        .timeout(Duration::from_secs(3))
        .finish();
    let mut auth = client
        .get(format!(
            "{}{}",
            state.config.node_upstream, LLM_REFLECTION_AUTH_PATH
        ))
        .insert_header((
            "x-rudder-ingress-auth",
            state.config.authorization_key.as_str(),
        ));
    // The private Node adapter owns actor and permission checks. Forward only
    // credentials needed to reconstruct that actor, never client assertions.
    for name in [
        "host",
        "origin",
        "cookie",
        "authorization",
        "x-rudder-agent-id",
        "x-rudder-run-id",
    ] {
        if let Some(value) = request.headers().get(name) {
            auth = auth.insert_header((name, value.clone()));
        }
    }
    auth = auth
        .insert_header(("x-forwarded-for", identity.client_ip.as_str()))
        .insert_header(("x-real-ip", identity.client_ip.as_str()))
        .insert_header(("x-forwarded-proto", identity.scheme));
    let mut response = match auth
        .send_json(&serde_json::json!({
            "publicMethod": public_method,
            "publicPath": public_path,
            "requestId": request_id,
            "nonce": nonce,
        }))
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ingress_authorization_unavailable",
            );
        }
    };
    if !response.status().is_success() {
        let status = match response.status().as_u16() {
            401 => StatusCode::UNAUTHORIZED,
            403 => StatusCode::FORBIDDEN,
            400 => StatusCode::BAD_REQUEST,
            413 => StatusCode::PAYLOAD_TOO_LARGE,
            _ => StatusCode::SERVICE_UNAVAILABLE,
        };
        return state
            .foundation
            .json_error(status, "ingress_authorization_rejected");
    }
    let signed: serde_json::Value =
        match response.json::<serde_json::Value>().limit(128 * 1024).await {
            Ok(signed) => signed,
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "ingress_authorization_invalid",
                );
            }
        };
    let authorization: LlmReflectionAuthorizationResponse = match serde_json::from_value(signed) {
        Ok(authorization) => authorization,
        Err(_) => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ingress_authorization_invalid",
            );
        }
    };
    let key = state
        .foundation
        .config
        .actor_envelope_key
        .as_ref()
        .expect("checked before bind");
    if authorization.envelope.nonce != nonce
        || state
            .foundation
            .verify_actor_envelope_parts(
                key,
                &authorization.envelope,
                &request,
                LLM_REFLECTION_SCOPE,
                LLM_REFLECTION_ACTION,
                None,
                b"",
                &request_id,
            )
            .is_err()
    {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ingress_authorization_invalid",
        );
    }

    crate::llm_reflection::render(document, authorization.reflection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const INTERNAL: &str = "fedcba9876543210fedcba9876543210";

    #[actix_web::test]
    async fn active_authenticated_public_websocket_closes_when_ingress_stops() {
        use futures_util::{SinkExt, StreamExt};
        let authenticated = Arc::new(AtomicBool::new(false));
        let upstream_closed = Arc::new(AtomicBool::new(false));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new({
            let authenticated = authenticated.clone();
            let upstream_closed = upstream_closed.clone();
            move || {
                let authenticated = authenticated.clone();
                let upstream_closed = upstream_closed.clone();
                App::new().route(
                    "/api/orgs/{org_id}/events/ws",
                    web::get().to(move |request: HttpRequest, payload: web::Payload| {
                        let authenticated = authenticated.clone();
                        let upstream_closed = upstream_closed.clone();
                        async move {
                            assert_eq!(request.headers().get("cookie").unwrap(), "session=test");
                            assert_eq!(
                                request.headers().get("authorization").unwrap(),
                                "Bearer authenticated-test-agent"
                            );
                            assert_eq!(
                                request.headers().get("host").unwrap(),
                                "public.example:3100"
                            );
                            assert_eq!(request.uri().query(), Some("resume=a%2Bb"));
                            assert!(request.headers().get(ACTOR_ENVELOPE_HEADER).is_none());
                            authenticated.store(true, Ordering::SeqCst);
                            let (response, mut session, mut stream) =
                                actix_ws::handle(&request, payload).unwrap();
                            actix_web::rt::spawn(async move {
                                while let Some(message) = stream.recv().await {
                                    match message {
                                        Ok(actix_ws::Message::Close(reason)) => {
                                            upstream_closed.store(true, Ordering::SeqCst);
                                            let _ = session.close(reason).await;
                                            break;
                                        }
                                        Ok(actix_ws::Message::Text(text)) => {
                                            session.text(text).await.unwrap();
                                        }
                                        Ok(_) => {}
                                        Err(_) => {
                                            upstream_closed.store(true, Ordering::SeqCst);
                                            break;
                                        }
                                    }
                                }
                                if !upstream_closed.load(Ordering::SeqCst) {
                                    upstream_closed.store(true, Ordering::SeqCst);
                                }
                            });
                            response
                        }
                    }),
                )
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let mock_handle = mock.handle();
        let mock_task = actix_web::rt::spawn(mock);
        let runtime = PublicIngressRuntime::bind(
            PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL).unwrap(),
            Arc::new(
                AppState::new(ServerConfig {
                    actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                    shutdown_grace: Duration::from_secs(1),
                    ..ServerConfig::default()
                })
                .unwrap(),
            ),
        )
        .unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());
        let (response, mut socket) = awc::Client::default()
            .ws(format!("ws://{address}/api/orgs/10000000-0000-0000-0000-000000000001/events/ws?resume=a%2Bb"))
            .set_header("host", "public.example:3100")
            .set_header("cookie", "session=test")
            .set_header("authorization", "Bearer authenticated-test-agent")
            .set_header(ACTOR_ENVELOPE_HEADER, "untrusted-client-assertion")
            .connect().await.unwrap();
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::SWITCHING_PROTOCOLS
        );
        socket
            .send(awc::ws::Message::Text("resume-event".into()))
            .await
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            matches!(frame, awc::ws::Frame::Text(ref bytes) if bytes.as_ref() == b"resume-event")
        );
        assert!(authenticated.load(Ordering::SeqCst));
        tokio::time::timeout(Duration::from_secs(5), async {
            let stop = control.stop(true);
            let observe_close = async {
                loop {
                    match socket.next().await {
                        Some(Ok(awc::ws::Frame::Close(_))) | Some(Err(_)) | None => break,
                        Some(Ok(_)) => {}
                    }
                }
            };
            tokio::join!(stop, observe_close);
        })
        .await
        .expect("stopping ingress must close an active authenticated websocket");
        drop(socket);
        task.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !upstream_closed.load(Ordering::SeqCst) {
                actix_web::rt::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("stopping ingress must release the authenticated upstream socket");
        mock_handle.stop(true).await;
        mock_task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    async fn public_member_read_uses_adapter_signature_ignores_client_trust_and_never_proxies_query()
     {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new(|| {
            App::new()
                .route(
                    AUTH_PATH,
                    web::get().to(
                        |request: HttpRequest, body: web::Json<serde_json::Value>| async move {
                            assert_eq!(
                                request.headers().get("x-rudder-ingress-auth").unwrap(),
                                INTERNAL
                            );
                            assert_eq!(
                                request.headers().get("host").unwrap(),
                                "public.example:3100"
                            );
                            assert_eq!(
                                request.headers().get("authorization").unwrap(),
                                "Bearer test-agent"
                            );
                            assert!(request.headers().get(ACTOR_ENVELOPE_HEADER).is_none());
                            assert_eq!(
                                request.headers().get("x-rudder-agent-id").unwrap(),
                                "test-agent"
                            );
                            let now = unix_time_seconds();
                            let signed = ActorEnvelope::new(
                                ActorIdentity::new("agent", "test-agent").unwrap(),
                                body["organizationId"].as_str().unwrap(),
                                "session",
                                1,
                                ACTOR_ENVELOPE_AUDIENCE,
                                "GET",
                                body["publicPath"].as_str().unwrap(),
                                MEMBER_DIRECTORY_ACTION,
                                b"",
                                body["requestId"].as_str().unwrap(),
                                body["nonce"].as_str().unwrap(),
                                now - 1,
                                now + 30,
                            )
                            .unwrap()
                            .sign(SECRET.as_bytes())
                            .unwrap();
                            HttpResponse::Ok().json(signed)
                        },
                    ),
                )
                .default_service(web::to(|| async { HttpResponse::ImATeapot().finish() }))
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = mock.handle();
        actix_web::rt::spawn(mock);
        let state = web::Data::new(IngressState {
            foundation: Arc::new(
                AppState::new(ServerConfig {
                    actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                    ..ServerConfig::default()
                })
                .unwrap(),
            ),
            config: PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL)
                .unwrap(),
        });
        let app = test::init_service(App::new().app_data(state).route(
            "/api/orgs/{org_id}/members/directory",
            web::get().to(member_directory),
        ))
        .await;
        let request = test::TestRequest::get()
            .uri("/api/orgs/10000000-0000-0000-0000-000000000001/members/directory?query=a%2Bb&unused=1")
            .peer_addr("192.0.2.7:4000".parse().unwrap())
            .insert_header(("host", "public.example:3100"))
            .insert_header(("authorization", "Bearer test-agent"))
            .insert_header((ACTOR_ENVELOPE_HEADER, "untrusted-client-envelope"))
            .insert_header(("x-rudder-agent-id", "test-agent"))
            .to_request();
        let response = test::call_service(&app, request).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = test::read_body(response).await;
        // Authorized Rust path reached its own DB guard; no fallback to Node.
        assert!(String::from_utf8_lossy(&body).contains("database_disabled"));
        handle.stop(true).await;
    }

    #[actix_web::test]
    async fn public_member_read_rejects_body_before_calling_unavailable_adapter() {
        let state = web::Data::new(IngressState {
            foundation: Arc::new(AppState::new(ServerConfig::default()).unwrap()),
            config: PublicIngressConfig::new(
                "127.0.0.1:0".parse().unwrap(),
                "http://127.0.0.1:1",
                INTERNAL,
            )
            .unwrap(),
        });
        let app = test::init_service(App::new().app_data(state).route(
            "/api/orgs/{org_id}/members/directory",
            web::get().to(member_directory),
        ))
        .await;
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/api/orgs/10000000-0000-0000-0000-000000000001/members/directory")
                .set_payload("unexpected")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[actix_web::test]
    async fn root_llm_reflection_routes_verify_private_grants_and_fail_closed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let observations = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let proxy_requests = Arc::new(AtomicUsize::new(0));
        let mock = HttpServer::new({
            let observations = observations.clone();
            let proxy_requests = proxy_requests.clone();
            move || {
                let observations = observations.clone();
                let proxy_requests = proxy_requests.clone();
                App::new().route(
                    LLM_REFLECTION_AUTH_PATH,
                    web::get().to(move |request: HttpRequest, body: web::Json<serde_json::Value>| {
                        let observations = observations.clone();
                        async move {
                            assert_eq!(
                                request.headers().get("x-rudder-ingress-auth").unwrap(),
                                INTERNAL
                            );
                            assert_eq!(request.headers().get("host").unwrap(), "public.example:3100");
                            assert!(request.headers().get(ACTOR_ENVELOPE_HEADER).is_none());
                            let body = body.into_inner();
                            let public_path = body["publicPath"].as_str().unwrap();
                            observations.lock().unwrap().push(body.clone());
                            if public_path.contains("deny=1") {
                                return HttpResponse::Forbidden().finish();
                            }
                            if public_path.contains("unauthorized=1") {
                                return HttpResponse::Unauthorized().finish();
                            }
                            if public_path.contains("failure=1") {
                                return HttpResponse::ServiceUnavailable().finish();
                            }
                            if public_path.contains("malformed=1") {
                                return HttpResponse::Ok()
                                    .content_type("application/json")
                                    .body("not-json");
                            }
                            let reflection = if public_path.starts_with("/llms/agent-icons.txt") {
                                serde_json::json!({ "adapters": [], "iconNames": ["search"] })
                            } else if public_path.starts_with("/llms/agent-configuration/fixture.txt")
                                || public_path.starts_with("/llms/agent-configuration/%66ixture.txt")
                            {
                                serde_json::json!({ "adapters": [{ "type": "fixture", "agentConfigurationDoc": "# Fixture adapter\n" }], "iconNames": [] })
                            } else if public_path.starts_with("/llms/agent-configuration/missing.txt") {
                                serde_json::json!({ "adapters": [], "iconNames": [] })
                            } else {
                                serde_json::json!({ "adapters": [{ "type": "fixture", "agentConfigurationDoc": null }], "iconNames": [] })
                            };
                            let now = unix_time_seconds();
                            let nonce = if public_path.contains("bad-nonce=1") {
                                format!("{}-wrong", body["nonce"].as_str().unwrap())
                            } else {
                                body["nonce"].as_str().unwrap().to_owned()
                            };
                            let envelope_path = if public_path.contains("bad-path=1") {
                                "/llms/agent-icons.txt"
                            } else {
                                public_path
                            };
                            let mut envelope = ActorEnvelope::new(
                                ActorIdentity::new("user", "board-user").unwrap(),
                                LLM_REFLECTION_SCOPE,
                                "board-session",
                                1,
                                ACTOR_ENVELOPE_AUDIENCE,
                                body["publicMethod"].as_str().unwrap(),
                                envelope_path,
                                LLM_REFLECTION_ACTION,
                                b"",
                                body["requestId"].as_str().unwrap(),
                                nonce.as_str(),
                                now - 1,
                                now + 30,
                            )
                            .unwrap()
                            .sign(SECRET.as_bytes())
                            .unwrap();
                            if public_path.contains("bad-signature=1") {
                                envelope.signature = "00".repeat(32);
                            }
                            HttpResponse::Ok().json(serde_json::json!({
                                "envelope": envelope,
                                "reflection": reflection,
                            }))
                        }
                    }),
                )
                .default_service(web::to(move || {
                    let proxy_requests = proxy_requests.clone();
                    async move {
                        proxy_requests.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::ImATeapot().finish()
                    }
                }))
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let mock_handle = mock.handle();
        let mock_task = actix_web::rt::spawn(mock);
        let runtime = PublicIngressRuntime::bind(
            PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL).unwrap(),
            Arc::new(
                AppState::new(ServerConfig {
                    actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                    ..ServerConfig::default()
                })
                .unwrap(),
            ),
        )
        .unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());
        let client = awc::Client::default();

        let mut index = client
            .get(format!(
                "http://{address}/llms/agent-configuration.txt?source=rust"
            ))
            .insert_header(("host", "public.example:3100"))
            .insert_header((ACTOR_ENVELOPE_HEADER, "untrusted-client-envelope"))
            .send()
            .await
            .unwrap();
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(
            index.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain; charset=utf-8"
        );
        let index_body = index.body().await.unwrap();
        assert!(
            String::from_utf8_lossy(&index_body).contains("/llms/agent-configuration/fixture.txt")
        );

        let encoded_runtime_path =
            "/llms/agent-configuration/%66ixture.txt?repeated=a%2Bb&repeated=2";
        let mut adapter = client
            .get(format!("http://{address}{encoded_runtime_path}"))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(adapter.status(), StatusCode::OK);
        assert_eq!(
            adapter.body().await.unwrap().as_ref(),
            b"# Fixture adapter\n"
        );

        let encoded_slash_path = "/llms/agent-configuration/foo%2Fbar.txt?raw=a%2Bb";
        let mut encoded_slash = client
            .get(format!("http://{address}{encoded_slash_path}"))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(encoded_slash.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            encoded_slash.body().await.unwrap().as_ref(),
            b"Unknown adapter type: foo/bar"
        );

        let mut icons = client
            .get(format!("http://{address}/llms/agent-icons.txt"))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(icons.status(), StatusCode::OK);
        assert!(String::from_utf8_lossy(&icons.body().await.unwrap()).contains("- search\n"));

        let mut head = client
            .head(format!("http://{address}/llms/agent-icons.txt"))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.body().await.unwrap().len(), 0);

        let denied = client
            .get(format!("http://{address}/llms/agent-icons.txt?deny=1"))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let unauthorized = client
            .get(format!(
                "http://{address}/llms/agent-icons.txt?unauthorized=1"
            ))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let failed = client
            .get(format!("http://{address}/llms/agent-icons.txt?failure=1"))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);

        for query in [
            "malformed=1",
            "bad-nonce=1",
            "bad-signature=1",
            "bad-path=1",
        ] {
            let invalid = client
                .get(format!("http://{address}/llms/agent-icons.txt?{query}"))
                .insert_header(("host", "public.example:3100"))
                .send()
                .await
                .unwrap();
            assert_eq!(
                invalid.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "{query} must fail closed"
            );
        }

        let mut unknown = client
            .get(format!(
                "http://{address}/llms/agent-configuration/missing.txt"
            ))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            unknown.body().await.unwrap().as_ref(),
            b"Unknown adapter type: missing"
        );

        let alias_proxy_count = proxy_requests.load(Ordering::SeqCst);
        for alias_path in [
            "/LLMS/agent-icons.txt",
            "/llms/agent-icons.txt/",
            "/LlMs/agent-configuration/fixture.txt/",
            "/llms/agent-configuration/a/b.txt",
        ] {
            let alias = client
                .get(format!("http://{address}{alias_path}"))
                .insert_header(("host", "public.example:3100"))
                .send()
                .await
                .unwrap();
            assert_eq!(alias.status(), StatusCode::NOT_FOUND, "{alias_path}");
        }
        assert_eq!(
            proxy_requests.load(Ordering::SeqCst),
            alias_proxy_count,
            "case, trailing-slash, and unmatched /llms paths must not fall back to Node"
        );

        let unrelated = client
            .get(format!("http://{address}/api/not-migrated"))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(unrelated.status(), StatusCode::IM_A_TEAPOT);
        assert_eq!(proxy_requests.load(Ordering::SeqCst), alias_proxy_count + 1);

        let private_observation_count = observations.lock().unwrap().len();
        let private_proxy_count = proxy_requests.load(Ordering::SeqCst);
        for private_path in [
            LLM_REFLECTION_AUTH_PATH,
            "/api/%5Finternal/rudder-ingress/authorize-llm-reflection/",
        ] {
            let response = client
                .get(format!("http://{address}{private_path}"))
                .insert_header(("host", "public.example:3100"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{private_path}");
        }
        assert_eq!(
            observations.lock().unwrap().len(),
            private_observation_count,
            "public requests must never reach the private Node auth adapter"
        );
        assert_eq!(
            proxy_requests.load(Ordering::SeqCst),
            private_proxy_count,
            "private auth adapter paths must not reach the generic Node proxy"
        );

        let observed = observations.lock().unwrap();
        assert_eq!(
            observed[0]["publicPath"],
            "/llms/agent-configuration.txt?source=rust"
        );
        assert_eq!(observed[1]["publicPath"], encoded_runtime_path);
        assert_eq!(observed[2]["publicPath"], encoded_slash_path);
        assert_eq!(observed[4]["publicMethod"], "HEAD");
        assert!(
            observed
                .iter()
                .all(|entry| entry["publicPath"].as_str().unwrap().starts_with("/llms/"))
        );
        drop(observed);
        mock_handle.stop(true).await;
        mock_task.await.unwrap().unwrap();
        let unavailable = client
            .get(format!(
                "http://{address}/llms/agent-icons.txt?transport=unavailable"
            ))
            .insert_header(("host", "public.example:3100"))
            .send()
            .await
            .unwrap();
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        control.stop(true).await;
        task.await.unwrap().unwrap();
    }
}
