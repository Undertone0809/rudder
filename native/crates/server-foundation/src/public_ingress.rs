//! Public listener with a direct Rust read and an explicit unmigrated proxy.
//! The private foundation router is deliberately not mounted on this socket.

use super::*;
use crate::native_bearer_auth::{NativeBearerResolution, is_native_bearer};
use crate::public_ingress_proxy::PublicIngressProxy;
use crate::public_ingress_websocket::PublicIngressWebSocketProxy;
use uuid::Uuid;

const AUTH_PATH: &str = "/api/_internal/rudder-ingress/authorize-member-directory";

fn bearer_token(request: &HttpRequest) -> Option<&str> {
    let value = request
        .headers()
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    if !value
        .as_bytes()
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"bearer "))
    {
        return None;
    }
    Some(value[7..].trim())
}

fn has_authentication_candidate(request: &HttpRequest) -> bool {
    bearer_token(request).is_some_and(|token| !token.is_empty())
        || request
            .headers()
            .get(header::COOKIE)
            .is_some_and(|value| !value.as_bytes().is_empty())
}

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
    websocket_proxy: web::Data<PublicIngressWebSocketProxy>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
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
    // Required ingress must reject an anonymous direct read locally. Keep any
    // non-empty bearer or cookie on the compatibility seam: Node owns JWT and
    // session validation, including its bearer-before-cookie precedence.
    if state.config.auth_requirement == PublicIngressAuthRequirement::Required
        && !has_authentication_candidate(&request)
    {
        return state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "authentication_required");
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
    // For API-key GETs, Node only attaches x-rudder-run-id as context and does
    // not validate it; the signed run-ID mismatch rule belongs to the local
    // Agent-JWT compatibility path. The x-rudder-agent-id fence is mutation-
    // only, so this native read intentionally does not apply either fence.
    let native_signed = match bearer_token(&request) {
        Some(token) if is_native_bearer(token) => {
            match state
                .foundation
                .resolve_native_bearer(token, org_id.as_str())
                .await
            {
                NativeBearerResolution::Authorized { actor, session_id } => {
                    let Some(key) = state.foundation.config.actor_envelope_key.as_ref() else {
                        return state.foundation.json_error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "actor_envelope_unconfigured",
                        );
                    };
                    let now = unix_time_seconds();
                    match ActorEnvelope::new(
                        actor,
                        org_id.as_str(),
                        session_id,
                        1,
                        ACTOR_ENVELOPE_AUDIENCE,
                        "GET",
                        &public_path,
                        MEMBER_DIRECTORY_ACTION,
                        b"",
                        &request_id,
                        &nonce,
                        now.saturating_sub(1),
                        now.saturating_add(30),
                    )
                    .and_then(|unsigned| unsigned.sign_with_key(key))
                    {
                        Ok(envelope) => Some(envelope),
                        Err(_) => {
                            return state.foundation.json_error(
                                StatusCode::SERVICE_UNAVAILABLE,
                                "native_auth_envelope_invalid",
                            );
                        }
                    }
                }
                NativeBearerResolution::Unauthorized
                    if state.config.auth_requirement == PublicIngressAuthRequirement::Optional =>
                {
                    // Node's optional-auth middleware starts with the local
                    // trusted Board actor. An absent, revoked, expired, or
                    // inactive bearer leaves that actor in place. Reproduce
                    // that policy here directly; do not retry through Node.
                    let Some(key) = state.foundation.config.actor_envelope_key.as_ref() else {
                        return state.foundation.json_error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "actor_envelope_unconfigured",
                        );
                    };
                    let actor = ActorIdentity::new("user", "local-board")
                        .expect("static local Board actor identity is valid");
                    let now = unix_time_seconds();
                    match ActorEnvelope::new(
                        actor,
                        org_id.as_str(),
                        "local-implicit",
                        1,
                        ACTOR_ENVELOPE_AUDIENCE,
                        "GET",
                        &public_path,
                        MEMBER_DIRECTORY_ACTION,
                        b"",
                        &request_id,
                        &nonce,
                        now.saturating_sub(1),
                        now.saturating_add(30),
                    )
                    .and_then(|unsigned| unsigned.sign_with_key(key))
                    {
                        Ok(envelope) => Some(envelope),
                        Err(_) => {
                            return state.foundation.json_error(
                                StatusCode::SERVICE_UNAVAILABLE,
                                "native_auth_envelope_invalid",
                            );
                        }
                    }
                }
                NativeBearerResolution::Unauthorized => {
                    return state
                        .foundation
                        .json_error(StatusCode::UNAUTHORIZED, "native_bearer_unauthorized");
                }
                NativeBearerResolution::Forbidden => {
                    return state
                        .foundation
                        .json_error(StatusCode::FORBIDDEN, "native_bearer_forbidden");
                }
                NativeBearerResolution::DatabaseDisabled => {
                    return state
                        .foundation
                        .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
                }
                NativeBearerResolution::Unavailable => {
                    return state.foundation.json_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "native_bearer_auth_unavailable",
                    );
                }
                NativeBearerResolution::Compatibility => {
                    unreachable!("recognized native bearer cannot select the compatibility path")
                }
            }
        }
        _ => None,
    };

    let signed = if let Some(envelope) = native_signed {
        match serde_json::to_value(envelope) {
            Ok(signed) => signed,
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_auth_envelope_invalid",
                );
            }
        }
    } else {
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
        // Explicit compatibility seam for sessions, local Agent JWTs, and
        // local-trusted/local-implicit behavior. Keep the public GET and never
        // send client-supplied signed envelopes or forwarding claims.
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
        match response.json::<serde_json::Value>().limit(32 * 1024).await {
            Ok(signed) => signed,
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "ingress_authorization_invalid",
                );
            }
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const INTERNAL: &str = "fedcba9876543210fedcba9876543210";
    const ORG_ID: &str = "10000000-0000-0000-0000-000000000001";
    const SESSION_COOKIE: &str = "session=test";
    // Signed with the default development JWT secret and scoped to ORG_ID.
    const LOCAL_JWT_AUTHORIZATION: &str = concat!(
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
        "eyJzdWIiOiJqd3QtYWdlbnQiLCJvcmdfaWQiOiIxMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJhZGFwdGVyX3R5cGUiOiJjb2RleCIsInJ1bl9pZCI6InRjcC1hdXRoLXRlc3QiLCJpYXQiOjE3NjAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMCwiaXNzIjoicnVkZGVyIiwiYXVkIjoicnVkZGVyLWFwaSJ9.",
        "wscHrGkf2pLOU6aUmn9teObGq2Yq6bcsz_Yn-a23QfQ"
    );

    fn auth_test_foundation() -> Arc<AppState> {
        Arc::new(
            AppState::new(ServerConfig {
                actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                ..ServerConfig::default()
            })
            .unwrap(),
        )
    }

    async fn public_member_get(
        address: SocketAddr,
        headers: &[(&str, &str)],
    ) -> (StatusCode, String) {
        let mut request = awc::Client::default().get(format!(
            "http://{address}/api/orgs/{ORG_ID}/members/directory"
        ));
        for (name, value) in headers {
            request = request.insert_header((*name, *value));
        }
        let mut response = request.send().await.unwrap();
        let status = response.status();
        let body = response.body().await.unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn signed_adapter_response(
        body: &serde_json::Value,
        actor_type: &str,
        actor_id: &str,
        session_id: &str,
    ) -> HttpResponse {
        let now = unix_time_seconds();
        match ActorEnvelope::new(
            ActorIdentity::new(actor_type, actor_id).unwrap(),
            body["organizationId"].as_str().unwrap(),
            session_id,
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "GET",
            body["publicPath"].as_str().unwrap(),
            MEMBER_DIRECTORY_ACTION,
            b"",
            body["requestId"].as_str().unwrap(),
            body["nonce"].as_str().unwrap(),
            now.saturating_sub(1),
            now.saturating_add(30),
        )
        .and_then(|unsigned| unsigned.sign(SECRET.as_bytes()))
        {
            Ok(signed) => HttpResponse::Ok().json(signed),
            Err(_) => HttpResponse::InternalServerError().finish(),
        }
    }

    #[actix_web::test]
    async fn required_public_tcp_member_read_rejects_empty_credentials_before_node() {
        let upstream_reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unavailable_upstream = format!("http://{}", upstream_reservation.local_addr().unwrap());
        drop(upstream_reservation);

        let config = PublicIngressConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            &unavailable_upstream,
            INTERNAL,
        )
        .unwrap();
        let runtime = PublicIngressRuntime::bind(config, auth_test_foundation()).unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());

        let cases: [(&str, &[(&str, &str)]); 5] = [
            ("absent credentials", &[]),
            ("empty cookie", &[("cookie", "")]),
            ("empty authorization", &[("authorization", "")]),
            (
                "malformed authorization",
                &[("authorization", "Basic malformed")],
            ),
            ("empty bearer", &[("authorization", "Bearer ")]),
        ];
        for (case, headers) in cases {
            let (status, body) = public_member_get(address, headers).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{case}: {body}");
            assert!(body.contains("authentication_required"), "{case}: {body}");
        }

        control.stop(true).await;
        task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    async fn public_tcp_auth_preserves_cookie_jwt_node_precedence_and_optional_local_board() {
        let adapter_calls = Arc::new(AtomicUsize::new(0));
        let observations = Arc::new(std::sync::Mutex::new(
            Vec::<(Option<String>, Option<String>)>::new(),
        ));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new({
            let adapter_calls = adapter_calls.clone();
            let observations = observations.clone();
            move || {
                let adapter_calls = adapter_calls.clone();
                let observations = observations.clone();
                App::new().route(
                    AUTH_PATH,
                    web::get().to(
                        move |request: HttpRequest, body: web::Json<serde_json::Value>| {
                            let adapter_calls = adapter_calls.clone();
                            let observations = observations.clone();
                            async move {
                                adapter_calls.fetch_add(1, Ordering::SeqCst);
                                let authorization = request
                                    .headers()
                                    .get(header::AUTHORIZATION)
                                    .and_then(|value| value.to_str().ok())
                                    .map(str::to_owned);
                                let cookie = request
                                    .headers()
                                    .get(header::COOKIE)
                                    .and_then(|value| value.to_str().ok())
                                    .map(str::to_owned);
                                assert_eq!(
                                    request.headers().get("x-rudder-ingress-auth").unwrap(),
                                    INTERNAL
                                );
                                observations
                                    .lock()
                                    .unwrap()
                                    .push((authorization.clone(), cookie.clone()));

                                if let Some(value) = authorization.as_deref().filter(|value| {
                                    value.get(..7).is_some_and(|prefix| {
                                        prefix.eq_ignore_ascii_case("Bearer ")
                                    })
                                }) {
                                    let token = value[7..].trim();
                                    if token
                                        != LOCAL_JWT_AUTHORIZATION.strip_prefix("Bearer ").unwrap()
                                    {
                                        return HttpResponse::Unauthorized().finish();
                                    }
                                    return signed_adapter_response(
                                        &body,
                                        "agent",
                                        "jwt-agent",
                                        "agent-jwt:jwt-agent",
                                    );
                                }
                                if cookie.as_deref() == Some(SESSION_COOKIE) {
                                    return signed_adapter_response(
                                        &body,
                                        "user",
                                        "session-user",
                                        "session-id",
                                    );
                                }
                                signed_adapter_response(
                                    &body,
                                    "user",
                                    "local-board",
                                    "local-implicit",
                                )
                            }
                        },
                    ),
                )
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let adapter_handle = mock.handle();
        let adapter_task = actix_web::rt::spawn(mock);

        let required_config =
            PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL).unwrap();
        let required = PublicIngressRuntime::bind(required_config, auth_test_foundation()).unwrap();
        let required_address = required.bound_addr();
        let required_control = required.control();
        let required_task = actix_web::rt::spawn(required.run());

        for (case, headers) in [
            ("missing", &[][..]),
            ("empty cookie", &[("cookie", "")][..]),
            (
                "malformed without cookie",
                &[("authorization", "Basic malformed")][..],
            ),
        ] {
            let (status, body) = public_member_get(required_address, headers).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{case}: {body}");
            assert!(body.contains("authentication_required"), "{case}: {body}");
        }
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);
        assert!(observations.lock().unwrap().is_empty());

        for (case, headers) in [
            ("session cookie", &[("cookie", SESSION_COOKIE)][..]),
            (
                "malformed header keeps Node cookie precedence",
                &[
                    ("authorization", "Basic malformed"),
                    ("cookie", SESSION_COOKIE),
                ][..],
            ),
            (
                "empty authorization keeps Node cookie precedence",
                &[("authorization", ""), ("cookie", SESSION_COOKIE)][..],
            ),
            (
                "local JWT bearer keeps Node bearer precedence",
                &[
                    ("authorization", LOCAL_JWT_AUTHORIZATION),
                    ("cookie", SESSION_COOKIE),
                ][..],
            ),
        ] {
            let (status, body) = public_member_get(required_address, headers).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{case}: {body}");
            assert!(body.contains("database_disabled"), "{case}: {body}");
        }

        let (empty_bearer_status, empty_bearer_body) = public_member_get(
            required_address,
            &[("authorization", "Bearer "), ("cookie", SESSION_COOKIE)],
        )
        .await;
        let empty_bearer_observation = observations.lock().unwrap().last().cloned().unwrap();
        let node_treats_as_bearer = empty_bearer_observation.0.as_deref().is_some_and(|value| {
            value
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
        });
        if node_treats_as_bearer
            && empty_bearer_observation
                .0
                .as_deref()
                .is_some_and(|value| value[7..].trim().is_empty())
        {
            assert_eq!(
                empty_bearer_status,
                StatusCode::UNAUTHORIZED,
                "{empty_bearer_body}"
            );
            assert!(empty_bearer_body.contains("ingress_authorization_rejected"));
        } else {
            assert_eq!(
                empty_bearer_status,
                StatusCode::SERVICE_UNAVAILABLE,
                "{empty_bearer_body}"
            );
            assert!(empty_bearer_body.contains("database_disabled"));
        }

        assert_eq!(adapter_calls.load(Ordering::SeqCst), 5);
        {
            let seen = observations.lock().unwrap();
            assert_eq!(seen[0].1.as_deref(), Some(SESSION_COOKIE));
            assert_eq!(
                seen[1],
                (
                    Some("Basic malformed".to_owned()),
                    Some(SESSION_COOKIE.to_owned())
                )
            );
            assert_eq!(seen[2].1.as_deref(), Some(SESSION_COOKIE));
            assert_eq!(seen[3].0.as_deref(), Some(LOCAL_JWT_AUTHORIZATION));
            assert_eq!(seen[3].1.as_deref(), Some(SESSION_COOKIE));
        }

        let optional_config =
            PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL)
                .unwrap()
                .with_auth_requirement(PublicIngressAuthRequirement::Optional);
        let optional = PublicIngressRuntime::bind(optional_config, auth_test_foundation()).unwrap();
        let optional_address = optional.bound_addr();
        let optional_control = optional.control();
        let optional_task = actix_web::rt::spawn(optional.run());
        let (status, body) = public_member_get(optional_address, &[]).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert!(body.contains("database_disabled"));
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 6);
        assert_eq!(
            observations.lock().unwrap().last().cloned().unwrap(),
            (None, None),
            "optional local-implicit auth must retain the Node compatibility seam"
        );
        let (status, body) = public_member_get(optional_address, &[("cookie", "")]).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert!(body.contains("database_disabled"));
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 7);
        let optional_empty_cookie = observations.lock().unwrap().last().cloned().unwrap();
        assert!(optional_empty_cookie.0.is_none());
        assert!(optional_empty_cookie.1.as_deref().is_none_or(str::is_empty));

        let (status, body) =
            public_member_get(optional_address, &[("cookie", SESSION_COOKIE)]).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert!(body.contains("database_disabled"));
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 8);
        assert_eq!(
            observations
                .lock()
                .unwrap()
                .last()
                .cloned()
                .unwrap()
                .1
                .as_deref(),
            Some(SESSION_COOKIE),
            "optional session cookies must retain the Node compatibility seam"
        );

        required_control.stop(true).await;
        required_task.await.unwrap().unwrap();
        optional_control.stop(true).await;
        optional_task.await.unwrap().unwrap();
        adapter_handle.stop(true).await;
        adapter_task.await.unwrap().unwrap();
    }

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
                                "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LWFnZW50In0.signature"
                            );
                            assert_eq!(request.headers().get("cookie").unwrap(), "session=test");
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
                // JWT-shaped bearer credentials stay on the legacy Node seam;
                // this mock validates routing, not the local JWT signature.
                .insert_header((
                    "authorization",
                    "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LWFnZW50In0.signature",
                ))
                .insert_header(("cookie", "session=test"))
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
    async fn credential_free_member_read_keeps_local_implicit_decision_on_node_seam() {
        let adapter_calls = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new({
            let adapter_calls = adapter_calls.clone();
            move || {
                let adapter_calls = adapter_calls.clone();
                App::new().route(
                    AUTH_PATH,
                    web::get().to(
                        move |request: HttpRequest, body: web::Json<serde_json::Value>| {
                            let adapter_calls = adapter_calls.clone();
                            async move {
                                adapter_calls.fetch_add(1, Ordering::SeqCst);
                                assert_eq!(
                                    request.headers().get("x-rudder-ingress-auth").unwrap(),
                                    INTERNAL
                                );
                                assert!(request.headers().get("authorization").is_none());
                                assert!(request.headers().get("cookie").is_none());
                                assert_eq!(
                                    request.headers().get("x-forwarded-for").unwrap(),
                                    "192.0.2.7"
                                );
                                let now = unix_time_seconds();
                                let signed = ActorEnvelope::new(
                                    ActorIdentity::new("user", "local-board").unwrap(),
                                    body["organizationId"].as_str().unwrap(),
                                    "local-implicit",
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
                            }
                        },
                    ),
                )
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = mock.handle();
        let task = actix_web::rt::spawn(mock);
        let state = web::Data::new(IngressState {
            foundation: Arc::new(
                AppState::new(ServerConfig {
                    actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                    ..ServerConfig::default()
                })
                .unwrap(),
            ),
            config: PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL)
                .unwrap()
                .with_auth_requirement(PublicIngressAuthRequirement::Optional),
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
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            String::from_utf8_lossy(&test::read_body(response).await).contains("database_disabled")
        );
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 1);
        handle.stop(true).await;
        task.await.unwrap().unwrap();
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
    async fn native_bearer_database_disabled_does_not_call_node_grant_adapter() {
        let adapter_calls = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new({
            let adapter_calls = adapter_calls.clone();
            move || {
                let adapter_calls = adapter_calls.clone();
                App::new().default_service(web::to(move || {
                    let adapter_calls = adapter_calls.clone();
                    async move {
                        adapter_calls.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::Ok().finish()
                    }
                }))
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = mock.handle();
        let task = actix_web::rt::spawn(mock);

        for auth_requirement in [
            PublicIngressAuthRequirement::Required,
            PublicIngressAuthRequirement::Optional,
        ] {
            let state = web::Data::new(IngressState {
                foundation: Arc::new(
                    AppState::new(ServerConfig {
                        actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                        ..ServerConfig::default()
                    })
                    .unwrap(),
                ),
                config: PublicIngressConfig::new(
                    "127.0.0.1:0".parse().unwrap(),
                    &upstream,
                    INTERNAL,
                )
                .unwrap()
                .with_auth_requirement(auth_requirement),
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
                    .peer_addr("192.0.2.7:4000".parse().unwrap())
                    .insert_header(("host", "public.example:3100"))
                    .insert_header(("authorization", "Bearer pcp_unknown_native_key"))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let body = test::read_body(response).await;
            assert!(String::from_utf8_lossy(&body).contains("database_disabled"));
        }
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        handle.stop(true).await;
        task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    #[ignore = "isolated PostgreSQL transport failure case; never contacts the compatibility grant adapter"]
    async fn native_bearer_sql_error_does_not_call_node_grant_adapter() {
        let adapter_calls = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new({
            let adapter_calls = adapter_calls.clone();
            move || {
                let adapter_calls = adapter_calls.clone();
                App::new().default_service(web::to(move || {
                    let adapter_calls = adapter_calls.clone();
                    async move {
                        adapter_calls.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::Ok().finish()
                    }
                }))
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = mock.handle();
        let task = actix_web::rt::spawn(mock);

        let state = web::Data::new(IngressState {
            foundation: Arc::new(
                AppState::new(ServerConfig {
                    database_url: Some(
                        "postgres://invalid:invalid@127.0.0.1:1/native_auth_unavailable".into(),
                    ),
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
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/api/orgs/10000000-0000-0000-0000-000000000001/members/directory")
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", "Bearer pcp_unknown_native_key"))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = test::read_body(response).await;
        assert!(String::from_utf8_lossy(&body).contains("native_bearer_auth_unavailable"));
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        handle.stop(true).await;
        task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    #[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
    async fn postgres_public_member_route_uses_native_board_key_without_node_grant() {
        use sqlx::postgres::PgPoolOptions;

        let database_url = std::env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL")
            .expect("set RUDDER_NATIVE_AUTH_TEST_DATABASE_URL to a migrated disposable DB");
        let parsed = url::Url::parse(&database_url).expect("test database URL must be valid");
        assert!(
            parsed
                .path()
                .trim_start_matches('/')
                .to_ascii_lowercase()
                .contains("test"),
            "refusing auth fixtures unless database name contains 'test'"
        );
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&database_url)
            .await
            .expect("connect to migrated disposable database");
        let suffix = Uuid::new_v4().simple().to_string();
        let org_id: String = sqlx::query_scalar(
            "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
        )
        .bind(format!("native-route-{suffix}"))
        .bind(format!("Native route {suffix}"))
        .bind(format!("R{}", suffix[..7].to_ascii_uppercase()))
        .fetch_one(&pool)
        .await
        .unwrap();
        let other_org_id: String = sqlx::query_scalar(
            "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
        )
        .bind(format!("native-route-other-{suffix}"))
        .bind(format!("Native route other {suffix}"))
        .bind(format!("S{}", suffix[..7].to_ascii_uppercase()))
        .fetch_one(&pool)
        .await
        .unwrap();
        let user_id = format!("native-route-user-{suffix}");
        sqlx::query(
            r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
               VALUES ($1, 'Native Route User', $2, now(), now())"#,
        )
        .bind(&user_id)
        .bind(format!("{user_id}@invalid.test"))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
        )
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        let token = format!("pcp_board_{suffix}");
        let key_id: String = sqlx::query_scalar(
            "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'native route test', $2) RETURNING id::text",
        )
        .bind(&user_id)
        .bind(crate::native_bearer_auth::hash_token(&token))
        .fetch_one(&pool)
        .await
        .unwrap();
        let agent_id: String = sqlx::query_scalar(
            "INSERT INTO agents (org_id, name, status) VALUES ($1::uuid, 'Native Route Agent', 'idle') RETURNING id::text",
        )
        .bind(&org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let agent_token = format!("pcp_{suffix}");
        let agent_key_id: String = sqlx::query_scalar(
            "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'native route agent test', $3) RETURNING id::text",
        )
        .bind(&agent_id)
        .bind(&org_id)
        .bind(crate::native_bearer_auth::hash_token(&agent_token))
        .fetch_one(&pool)
        .await
        .unwrap();

        // A token hash may be present in both credential tables. The public
        // route must retain Node's Board-key-first precedence: this Board key
        // lacks access to `other_org_id`, while its colliding agent key owns it.
        let collision_token = format!("pcp_board_collision_{suffix}");
        let collision_board_key_id: String = sqlx::query_scalar(
            "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'native route collision board', $2) RETURNING id::text",
        )
        .bind(&user_id)
        .bind(crate::native_bearer_auth::hash_token(&collision_token))
        .fetch_one(&pool)
        .await
        .unwrap();
        let collision_agent_id: String = sqlx::query_scalar(
            "INSERT INTO agents (org_id, name, status) VALUES ($1::uuid, 'Native Collision Agent', 'idle') RETURNING id::text",
        )
        .bind(&other_org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let collision_agent_key_id: String = sqlx::query_scalar(
            "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'native route collision agent', $3) RETURNING id::text",
        )
        .bind(&collision_agent_id)
        .bind(&other_org_id)
        .bind(crate::native_bearer_auth::hash_token(&collision_token))
        .fetch_one(&pool)
        .await
        .unwrap();
        let expired_token = format!("pcp_board_expired_{suffix}");
        let expired_key_id: String = sqlx::query_scalar(
            "INSERT INTO board_api_keys (user_id, name, key_hash, expires_at) VALUES ($1, 'native route expired', $2, now() - interval '1 second') RETURNING id::text",
        )
        .bind(&user_id)
        .bind(crate::native_bearer_auth::hash_token(&expired_token))
        .fetch_one(&pool)
        .await
        .unwrap();

        let adapter_calls = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new({
            let adapter_calls = adapter_calls.clone();
            move || {
                let adapter_calls = adapter_calls.clone();
                App::new().default_service(web::to(move || {
                    let adapter_calls = adapter_calls.clone();
                    async move {
                        adapter_calls.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::Unauthorized().finish()
                    }
                }))
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .unwrap()
        .run();
        let handle = mock.handle();
        let task = actix_web::rt::spawn(mock);

        let state = web::Data::new(IngressState {
            foundation: Arc::new(
                AppState::new(ServerConfig {
                    database_url: Some(database_url.clone()),
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
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {token}")))
                .insert_header(("x-rudder-run-id", "caller-run-context"))
                // GET intentionally does not apply mutation-only agent ID fences.
                .insert_header(("x-rudder-agent-id", "unrelated-agent"))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = test::read_body(response).await;
        assert!(String::from_utf8_lossy(&body).contains("Native Route User"));
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);
        let touched: bool = sqlx::query_scalar(
            "SELECT last_used_at IS NOT NULL FROM board_api_keys WHERE id = $1::uuid",
        )
        .bind(&key_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(touched);

        let cross_org_board = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{other_org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(cross_org_board.status(), StatusCode::FORBIDDEN);

        let collision = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{other_org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {collision_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(collision.status(), StatusCode::FORBIDDEN);
        // If the colliding agent key had been consulted, this exact request
        // would have been authorized for the agent's organization.
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        let cross_org_agent = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{other_org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {agent_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(cross_org_agent.status(), StatusCode::FORBIDDEN);

        sqlx::query(
            "UPDATE organization_memberships SET status = 'inactive' WHERE org_id = $1::uuid AND principal_type = 'user' AND principal_id = $2",
        )
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        let inactive_membership = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(inactive_membership.status(), StatusCode::FORBIDDEN);
        sqlx::query(
            "UPDATE organization_memberships SET status = 'active' WHERE org_id = $1::uuid AND principal_type = 'user' AND principal_id = $2",
        )
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();

        let expired = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {expired_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(expired.status(), StatusCode::UNAUTHORIZED);
        assert!(
            !sqlx::query_scalar::<_, bool>(
                "SELECT last_used_at IS NOT NULL FROM board_api_keys WHERE id = $1::uuid",
            )
            .bind(&expired_key_id)
            .fetch_one(&pool)
            .await
            .unwrap()
        );

        let unknown = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", "Bearer pcp_unknown_route_key"))
                .to_request(),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        let optional_state = web::Data::new(IngressState {
            foundation: Arc::new(
                AppState::new(ServerConfig {
                    database_url: Some(database_url),
                    actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                    ..ServerConfig::default()
                })
                .unwrap(),
            ),
            config: PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL)
                .unwrap()
                .with_auth_requirement(PublicIngressAuthRequirement::Optional),
        });
        let optional_app = test::init_service(App::new().app_data(optional_state).route(
            "/api/orgs/{org_id}/members/directory",
            web::get().to(member_directory),
        ))
        .await;
        let optional_unknown = test::call_service(
            &optional_app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", "Bearer pcp_unknown_route_key"))
                .to_request(),
        )
        .await;
        assert_eq!(optional_unknown.status(), StatusCode::OK);
        assert!(
            String::from_utf8_lossy(&test::read_body(optional_unknown).await)
                .contains("Native Route User")
        );

        let optional_valid_board = test::call_service(
            &optional_app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(optional_valid_board.status(), StatusCode::OK);

        let optional_valid_agent = test::call_service(
            &optional_app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {agent_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(optional_valid_agent.status(), StatusCode::OK);

        let optional_out_of_scope = test::call_service(
            &optional_app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{other_org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {collision_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(optional_out_of_scope.status(), StatusCode::FORBIDDEN);
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        let agent_response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {agent_token}")))
                .insert_header(("x-rudder-run-id", "api-key-run-context"))
                .insert_header(("x-rudder-agent-id", "different-agent-on-read"))
                .to_request(),
        )
        .await;
        assert_eq!(agent_response.status(), StatusCode::OK);
        let _: serde_json::Value = serde_json::from_slice(&test::read_body(agent_response).await)
            .expect("native agent API key should return the member-directory page");
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);
        let agent_touched: bool = sqlx::query_scalar(
            "SELECT last_used_at IS NOT NULL FROM agent_api_keys WHERE id = $1::uuid",
        )
        .bind(&agent_key_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(agent_touched);

        sqlx::query(
            "INSERT INTO instance_user_roles (user_id, role) VALUES ($1, 'instance_admin')",
        )
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        let invalid_org = test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/api/orgs/not-a-uuid/members/directory")
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(invalid_org.status(), StatusCode::NOT_FOUND);
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);
        sqlx::query("DELETE FROM instance_user_roles WHERE user_id = $1")
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("UPDATE board_api_keys SET revoked_at = now() WHERE id = $1::uuid")
            .bind(&key_id)
            .execute(&pool)
            .await
            .unwrap();
        let denied = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let optional_revoked = test::call_service(
            &optional_app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {token}")))
                .to_request(),
        )
        .await;
        assert_eq!(optional_revoked.status(), StatusCode::OK);
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        sqlx::query("UPDATE agents SET status = 'terminated' WHERE id = $1::uuid")
            .bind(&agent_id)
            .execute(&pool)
            .await
            .unwrap();
        let terminated_agent = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {agent_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(terminated_agent.status(), StatusCode::UNAUTHORIZED);

        sqlx::query("DELETE FROM agent_api_keys WHERE id = $1::uuid")
            .bind(&agent_key_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM agents WHERE id = $1::uuid")
            .bind(&agent_id)
            .execute(&pool)
            .await
            .unwrap();
        let deleted_agent = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/api/orgs/{org_id}/members/directory"))
                .peer_addr("192.0.2.7:4000".parse().unwrap())
                .insert_header(("host", "public.example:3100"))
                .insert_header(("authorization", format!("Bearer {agent_token}")))
                .to_request(),
        )
        .await;
        assert_eq!(deleted_agent.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(adapter_calls.load(Ordering::SeqCst), 0);

        sqlx::query("DELETE FROM agent_api_keys WHERE id = $1::uuid")
            .bind(&collision_agent_key_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM agents WHERE id = $1::uuid")
            .bind(&collision_agent_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM board_api_keys WHERE id IN ($1::uuid, $2::uuid, $3::uuid)")
            .bind(&key_id)
            .bind(&collision_board_key_id)
            .bind(&expired_key_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "DELETE FROM organization_memberships WHERE org_id = $1::uuid AND principal_id = $2",
        )
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(r#"DELETE FROM "user" WHERE id = $1"#)
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)")
            .bind(&org_id)
            .bind(&other_org_id)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        handle.stop(true).await;
        task.await.unwrap().unwrap();
    }
}
