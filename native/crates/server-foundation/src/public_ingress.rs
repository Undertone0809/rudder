//! Public listener with a direct Rust read and an explicit unmigrated proxy.
//! The private foundation router is deliberately not mounted on this socket.

use super::*;
use crate::public_ingress_proxy::PublicIngressProxy;
use uuid::Uuid;

const AUTH_PATH: &str = "/api/_internal/rudder-ingress/authorize-member-directory";

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
                .expect("validated fixed loopback upstream");
            App::new()
                .app_data(data.clone())
                .app_data(web::Data::new(proxy))
                .route("/healthz", web::get().to(ingress_health))
                .route("/readyz", web::get().to(ingress_readiness))
                .route(
                    "/api/orgs/{org_id}/members/directory",
                    web::get().to(member_directory),
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
    proxy: web::Data<PublicIngressProxy>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
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
        .post(format!("{}{}", state.config.node_upstream, AUTH_PATH))
        .insert_header((
            "x-rudder-ingress-auth",
            state.config.authorization_key.as_str(),
        ));
    // Existing middleware must still reject mismatched agent/run context.
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

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test;
    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const INTERNAL: &str = "fedcba9876543210fedcba9876543210";

    #[actix_web::test]
    async fn public_member_read_uses_adapter_signature_ignores_client_trust_and_never_proxies_query()
     {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new(|| {
            App::new()
                .route(
                    AUTH_PATH,
                    web::post().to(
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
}
