//! Public listener with a direct Rust read and an explicit unmigrated proxy.
//! The private foundation router is deliberately not mounted on this socket.

use super::*;
use crate::llm_reflection::{LlmReflectionDocument, LlmReflectionSnapshot};
use crate::native_session_auth::{NativeSessionIdentity, NativeSessionResolution, issue_assertion};
use crate::public_ingress_config::NativeSessionAuthKind;
use crate::public_ingress_proxy::{PRIVATE_LLM_REFLECTION_AUTH_ADAPTER_PATH, PublicIngressProxy};
use crate::public_ingress_websocket::PublicIngressWebSocketProxy;
use actix_web::guard;
use actix_web::http::Method;
use uuid::Uuid;

mod runtime_bindings;

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
    session_auth_kind: Option<NativeSessionAuthKind>,
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
                .wrap(middleware::from_fn(reject_unsupported_websocket_upgrade))
                .route("/healthz", web::get().to(ingress_health))
                .route("/readyz", web::get().to(ingress_readiness))
                .route(
                    "/api/orgs/{org_id}/members/directory",
                    web::get().to(member_directory),
                )
                .route(
                    "/api/orgs/{org_id}/chats/{chat_id}/runtime-binding",
                    web::get().to(runtime_bindings::current),
                )
                .route(
                    "/api/orgs/{org_id}/runtime-bindings/{binding_id}",
                    web::get().to(runtime_bindings::historical),
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
            session_auth_kind: config.session_auth.as_ref().map(|settings| settings.kind),
        })
    }

    pub fn bound_addr(&self) -> SocketAddr {
        self.bound_addr
    }
    pub fn startup_receipt(&self) -> serde_json::Value {
        public_ingress_startup_receipt(self.bound_addr, self.session_auth_kind)
    }
    pub fn control(&self) -> actix_web::dev::ServerHandle {
        self.handle.clone()
    }
    pub async fn run(self) -> std::io::Result<()> {
        self.server.await
    }
}

fn public_ingress_startup_receipt(
    bound_addr: SocketAddr,
    session_auth_kind: Option<NativeSessionAuthKind>,
) -> serde_json::Value {
    let mut direct_routes = vec!["/api/orgs/:org_id/members/directory"];
    if session_auth_kind.is_some() {
        direct_routes.push("/api/auth/get-session");
    }
    let mut native_authentication = serde_json::json!({
        "authority": "native-pcp-bearer-resolver",
        "recognizedBearerPrefix": "pcp_",
        "supportedCredentialStores": ["board_api_keys", "agent_api_keys"],
        "directRoutes": direct_routes,
        "recognizedInvalidCredentialsFailClosed": true,
    });
    if let Some(kind) = session_auth_kind {
        native_authentication["sessionCookieAuthority"] = serde_json::json!({
            "kind": match kind {
                NativeSessionAuthKind::BetterAuth => "better_auth",
                NativeSessionAuthKind::LocalAccount => "local_account",
            },
            "authority": "native-existing-session-cookie-resolver",
            "scope": "public_ingress_non_lifecycle_http_without_bearer",
            "assertionTransport": "one_time_method_target_bound_loopback_hmac",
            "nodeRechecksCurrentOrganizationRolesAndMemberships": true,
            "unmigrated": ["auth_lifecycle_routes", "websocket_session_resolution"],
        });
    }
    serde_json::json!({
        "boundAddr": bound_addr,
        "publicListener": true,
        "directAuthorities": if session_auth_kind.is_some() {
            vec!["native_pcp_bearer_resolver", "native_session_cookie_resolver"]
        } else {
            vec!["native_pcp_bearer_resolver"]
        },
        "nativeAuthentication": native_authentication,
        "compatibilityAuthentication": {
            "authority": "private-node-adapter",
            "credentialForms": [
                "local Agent JWTs",
                "local-trusted and local-implicit identities",
                "non-pcp_ bearer credentials",
                "Bearer-authenticated HTTP requests",
            ],
            "nodeOwnedRoutes": ["auth_lifecycle_routes", "websocket_session_resolution"],
        },
        "unmigratedHttpAuthority": "explicit-private-node-proxy",
    })
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
    if is_get_session_route(&request)
        && !has_bearer_header(&request)
        && state.config.session_auth.is_some()
    {
        return get_session(state, request).await;
    }
    // Express's compatibility router is case-insensitive and accepts an
    // optional trailing slash. Never let a near-match under this namespace
    // fall back to Node in required-Rust mode: exact migrated routes are
    // handled above, and every remaining /llms path is deliberately closed.
    if runtime_bindings::reserved_path(request.uri().path())
        || request
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

    if has_websocket_upgrade(&request) {
        if is_supported_websocket_upgrade_route(&request) {
            return websocket_proxy.forward(request, payload).await;
        }
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    }
    let Some(session_auth) = state.config.session_auth.as_ref() else {
        return proxy.forward(request, payload).await;
    };
    if has_bearer_header(&request) || is_node_owned_lifecycle_route(&request) {
        return proxy.forward(request, payload).await;
    }
    let identity = match state
        .foundation
        .resolve_public_session(session_auth, request.headers())
        .await
    {
        NativeSessionResolution::Authenticated(identity) => Some(identity),
        NativeSessionResolution::Anonymous => None,
        NativeSessionResolution::DatabaseDisabled => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        }
        NativeSessionResolution::Unavailable => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "native_session_unavailable",
            );
        }
    };
    let Some(path_and_query) = request.uri().path_and_query() else {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_request_target");
    };
    let proof = match issue_assertion(
        session_auth,
        request.method().as_str(),
        path_and_query.as_str(),
        identity.as_ref(),
    ) {
        Ok(proof) => proof,
        Err(_) => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "native_session_assertion_unavailable",
            );
        }
    };
    proxy
        .forward_with_session_assertion(request, payload, Some(&proof), Some(session_auth))
        .await
}

async fn reject_unsupported_websocket_upgrade(
    state: web::Data<IngressState>,
    request: ServiceRequest,
    next: Next<impl MessageBody + 'static>,
) -> Result<actix_web::dev::ServiceResponse<impl MessageBody>, Error> {
    if has_websocket_upgrade(request.request())
        && !is_supported_websocket_upgrade_route(request.request())
    {
        return Ok(request
            .into_response(
                state
                    .foundation
                    .json_error(StatusCode::NOT_FOUND, "route_not_found"),
            )
            .map_into_right_body());
    }
    Ok(next.call(request).await?.map_into_left_body())
}

fn has_websocket_upgrade(request: &HttpRequest) -> bool {
    request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("websocket"))
}

fn is_get_session_route(request: &HttpRequest) -> bool {
    matches!(*request.method(), Method::GET | Method::HEAD)
        && request
            .uri()
            .path()
            .trim_end_matches('/')
            .eq_ignore_ascii_case("/api/auth/get-session")
}

fn is_node_owned_lifecycle_route(request: &HttpRequest) -> bool {
    let path = request
        .uri()
        .path()
        .trim_end_matches('/')
        .to_ascii_lowercase();
    path == "/api/auth" || path.starts_with("/api/auth/")
}

fn has_bearer_header(request: &HttpRequest) -> bool {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("bearer "))
}

fn is_supported_websocket_upgrade_route(request: &HttpRequest) -> bool {
    if request.method() != Method::GET {
        return false;
    }
    let mut segments = request.uri().path().split('/');
    matches!(
        (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ),
        (Some(""), Some("api"), Some("orgs"), Some(org_id), Some("events"), Some("ws"), None)
            if !org_id.is_empty()
    )
}

async fn get_session(state: web::Data<IngressState>, request: HttpRequest) -> HttpResponse {
    let Some(session_auth) = state.config.session_auth.as_ref() else {
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    };
    match state
        .foundation
        .resolve_public_session(session_auth, request.headers())
        .await
    {
        NativeSessionResolution::Authenticated(identity) => {
            HttpResponse::Ok().json(native_get_session_body(&identity))
        }
        NativeSessionResolution::Anonymous => state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
        NativeSessionResolution::DatabaseDisabled => state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled"),
        NativeSessionResolution::Unavailable => state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_session_unavailable",
        ),
    }
}

fn native_get_session_body(identity: &NativeSessionIdentity) -> serde_json::Value {
    serde_json::json!({
        "session": { "id": format!("rudder:session:{}", identity.user_id), "userId": identity.user_id },
        "user": { "id": identity.user_id, "email": null, "name": null },
    })
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
    if let Some(token) =
        bearer_token(&request).filter(|token| native_bearer_auth::is_native_bearer(token))
    {
        return match state
            .foundation
            .resolve_native_bearer(token, org_id.as_str())
            .await
        {
            native_bearer_auth::NativeBearerResolution::Authorized {
                actor,
                session_id,
                token_hash,
            } => {
                state
                    .foundation
                    .organization_member_directory_with_native_auth(
                        org_id.as_str(),
                        query.into_inner(),
                        Some((&actor, &session_id, &token_hash)),
                    )
                    .await
            }
            native_bearer_auth::NativeBearerResolution::Compatibility => {
                state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_auth_classification_error",
                )
            }
            native_bearer_auth::NativeBearerResolution::Unauthorized => state
                .foundation
                .json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
            native_bearer_auth::NativeBearerResolution::Forbidden => state
                .foundation
                .json_error(StatusCode::FORBIDDEN, "forbidden"),
            native_bearer_auth::NativeBearerResolution::DatabaseDisabled => state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled"),
            native_bearer_auth::NativeBearerResolution::Unavailable => state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ingress_authorization_unavailable",
            ),
        };
    }
    if !has_bearer_header(&request)
        && let Some(session_auth) = state.config.session_auth.as_ref()
    {
        let identity = match state
            .foundation
            .resolve_public_session(session_auth, request.headers())
            .await
        {
            NativeSessionResolution::Authenticated(identity) => identity,
            NativeSessionResolution::Anonymous => {
                return state
                    .foundation
                    .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
            }
            NativeSessionResolution::DatabaseDisabled => {
                return state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
            }
            NativeSessionResolution::Unavailable => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_session_unavailable",
                );
            }
        };
        return state
            .foundation
            .organization_member_directory_with_native_session(
                org_id.as_str(),
                query.into_inner(),
                &identity,
                session_auth.kind,
            )
            .await;
    }
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

fn bearer_token(request: &HttpRequest) -> Option<&str> {
    let value = request
        .headers()
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
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
    let mut session_proof = None;
    let mut strip_auth_cookies = None;
    if !has_bearer_header(&request)
        && let Some(session_auth) = state.config.session_auth.as_ref()
    {
        let identity = match state
            .foundation
            .resolve_public_session(session_auth, request.headers())
            .await
        {
            NativeSessionResolution::Authenticated(identity) => Some(identity),
            NativeSessionResolution::Anonymous => None,
            NativeSessionResolution::DatabaseDisabled => {
                return state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
            }
            NativeSessionResolution::Unavailable => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_session_unavailable",
                );
            }
        };
        session_proof = match issue_assertion(
            session_auth,
            Method::GET.as_str(),
            LLM_REFLECTION_AUTH_PATH,
            identity.as_ref(),
        ) {
            Ok(proof) => Some(proof),
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_session_assertion_unavailable",
                );
            }
        };
        strip_auth_cookies = Some(session_auth);
    }
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
        if name == "cookie" && session_proof.is_some() {
            continue;
        }
        if let Some(value) = request.headers().get(name) {
            auth = auth.insert_header((name, value.clone()));
        }
    }
    if let Some(proof) = session_proof.as_deref() {
        auth = auth.insert_header(("x-rudder-native-session-proof", proof));
        if let Some(config) = strip_auth_cookies
            && let Some(cookie) = crate::public_ingress_proxy::filtered_session_cookie_header(
                request.headers(),
                config,
            )
        {
            auth = auth.insert_header((header::COOKIE, cookie));
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
    use crate::public_ingress_config::{NativeSessionAuthConfig, NativeSessionAuthKind};
    use actix_web::test;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use sqlx::{
        PgPool,
        postgres::{PgConnectOptions, PgPoolOptions},
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::{env, str::FromStr};
    use uuid::Uuid;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const INTERNAL: &str = "fedcba9876543210fedcba9876543210";
    type HmacSha256 = Hmac<Sha256>;

    fn signed_cookie(name: &str, token: &str, secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(token.as_bytes());
        let signed = format!("{token}.{}", STANDARD.encode(mac.finalize().into_bytes()));
        let encoded =
            percent_encoding::utf8_percent_encode(&signed, percent_encoding::NON_ALPHANUMERIC);
        format!("{name}={encoded}")
    }

    #[actix_web::test]
    async fn startup_receipt_reports_only_the_configured_public_auth_authorities() {
        let address = "127.0.0.1:3100".parse().unwrap();
        let bearer_only = public_ingress_startup_receipt(address, None);
        assert_eq!(bearer_only["publicListener"], true);
        assert_eq!(
            bearer_only["nativeAuthentication"]["directRoutes"],
            serde_json::json!(["/api/orgs/:org_id/members/directory"])
        );
        assert!(bearer_only["nativeAuthentication"]["sessionCookieAuthority"].is_null());

        let with_better_auth =
            public_ingress_startup_receipt(address, Some(NativeSessionAuthKind::BetterAuth));
        assert_eq!(
            with_better_auth["nativeAuthentication"]["directRoutes"],
            serde_json::json!([
                "/api/orgs/:org_id/members/directory",
                "/api/auth/get-session"
            ])
        );
        assert_eq!(
            with_better_auth["nativeAuthentication"]["sessionCookieAuthority"]["kind"],
            "better_auth"
        );
        assert_eq!(
            with_better_auth["nativeAuthentication"]["sessionCookieAuthority"]["unmigrated"],
            serde_json::json!(["auth_lifecycle_routes", "websocket_session_resolution"])
        );
        assert_eq!(
            with_better_auth["compatibilityAuthentication"]["nodeOwnedRoutes"],
            serde_json::json!(["auth_lifecycle_routes", "websocket_session_resolution"])
        );
        let rendered = with_better_auth.to_string();
        assert!(!rendered.contains("session-secret"));
        assert!(!rendered.contains("assertionKey"));
    }

    #[actix_web::test]
    async fn unsupported_websocket_upgrade_is_rejected_before_every_production_route() {
        let private_requests = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let mock = HttpServer::new({
            let private_requests = private_requests.clone();
            move || {
                let private_requests = private_requests.clone();
                App::new().default_service(web::to(move || {
                    let private_requests = private_requests.clone();
                    async move {
                        private_requests.fetch_add(1, Ordering::SeqCst);
                        HttpResponse::NoContent().finish()
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

        let config = ServerConfig {
            actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
            workers: 1,
            ..ServerConfig::default()
        };
        let foundation = Arc::new(AppState::new(config).unwrap());
        let mut ingress =
            PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL).unwrap();
        ingress.session_auth = Some(
            NativeSessionAuthConfig::new(
                NativeSessionAuthKind::BetterAuth,
                SECRET,
                false,
                "session-assertion-key-0123456789abcdef",
            )
            .unwrap(),
        );
        let runtime = PublicIngressRuntime::bind(ingress, foundation).unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());
        let client = awc::Client::default();
        for path in [
            "/api/auth/get-session",
            "/api/orgs/org-1/members/directory",
            "/api/ordinary-business-route",
        ] {
            let mut response = client
                .get(format!("http://{address}{path}"))
                .insert_header((header::UPGRADE, "websocket"))
                .insert_header((header::CONNECTION, "Upgrade"))
                .insert_header((header::SEC_WEBSOCKET_VERSION, "13"))
                .insert_header((header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ=="))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body["reason"], "route_not_found", "{path}");
        }
        assert_eq!(private_requests.load(Ordering::SeqCst), 0);
        control.stop(true).await;
        task.await.unwrap().unwrap();
        mock_handle.stop(true).await;
        mock_task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    async fn websocket_upgrade_exemption_matches_only_the_supported_route() {
        for path in ["/api/orgs/org-1/events/ws", "/api/orgs/a%2Fb/events/ws"] {
            let request = test::TestRequest::get().uri(path).to_http_request();
            assert!(is_supported_websocket_upgrade_route(&request), "{path}");
        }
        for path in [
            "/api/orgs//events/ws",
            "/api/orgs/org-1/events/ws/",
            "/api/orgs/org-1/members/directory",
            "/api/orgs/org-1/events/ws/other",
        ] {
            let request = test::TestRequest::get().uri(path).to_http_request();
            assert!(!is_supported_websocket_upgrade_route(&request), "{path}");
        }
        let request = test::TestRequest::post()
            .uri("/api/orgs/org-1/events/ws")
            .to_http_request();
        assert!(!is_supported_websocket_upgrade_route(&request));
    }

    async fn disposable_native_auth_pool() -> PgPool {
        let url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL")
            .expect("set RUDDER_NATIVE_AUTH_TEST_DATABASE_URL to a migrated disposable DB");
        let parsed = url::Url::parse(&url).expect("test database URL must be valid");
        assert!(
            parsed
                .path()
                .trim_start_matches('/')
                .to_ascii_lowercase()
                .contains("test"),
            "refusing public-ingress fixtures unless database name contains 'test'"
        );
        PgPoolOptions::new()
            .max_connections(4)
            .connect_with(
                PgConnectOptions::from_str(&url)
                    .expect("test database URL must be valid")
                    .application_name("rudder_native_public_route_test"),
            )
            .await
            .expect("connect to the migrated disposable test database")
    }

    #[actix_web::test]
    async fn native_session_database_disabled_fails_closed_without_node_fallback() {
        let config = ServerConfig {
            actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
            workers: 1,
            ..ServerConfig::default()
        };
        let foundation = Arc::new(AppState::new(config).unwrap());
        let mut ingress = PublicIngressConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:1",
            INTERNAL,
        )
        .unwrap();
        ingress.session_auth = Some(
            NativeSessionAuthConfig::new(
                NativeSessionAuthKind::BetterAuth,
                SECRET,
                false,
                "session-assertion-key-0123456789abcdef",
            )
            .unwrap(),
        );
        let runtime = PublicIngressRuntime::bind(ingress, foundation).unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());
        let client = awc::Client::default();
        let cookie = signed_cookie("better-auth.session_token", "valid-token", SECRET);
        let mut response = client
            .get(format!("http://{address}/api/auth/get-session"))
            .insert_header((header::COOKIE, cookie.as_str()))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "database_disabled");
        control.stop(true).await;
        task.await.unwrap().unwrap();
    }

    #[actix_web::test]
    #[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
    async fn native_pcp_member_directory_works_without_node_auth_and_fails_closed_after_revocation()
    {
        let pool = disposable_native_auth_pool().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let org_id: String = sqlx::query_scalar(
            "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
        )
        .bind(format!("native-route-{suffix}"))
        .bind(format!("Native route {suffix}"))
        .bind(format!("N{}", suffix[..7].to_ascii_uppercase()))
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
        let token = format!("pcp_native_route_{suffix}");
        let key_id: String = sqlx::query_scalar(
            "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'native route test', $2) RETURNING id::text",
        )
        .bind(&user_id)
        .bind(native_bearer_auth::hash_token(&token))
        .fetch_one(&pool)
        .await
        .unwrap();

        // Port 1 is intentionally unavailable. A successful native request
        // proves it did not depend on the private Node authorization adapter.
        let config = ServerConfig {
            database_url: Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
            actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
            workers: 1,
            ..ServerConfig::default()
        };
        let foundation = Arc::new(AppState::new(config).unwrap());
        let runtime = PublicIngressRuntime::bind(
            PublicIngressConfig::new(
                "127.0.0.1:0".parse().unwrap(),
                "http://127.0.0.1:1",
                INTERNAL,
            )
            .unwrap(),
            foundation,
        )
        .unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());
        let client = awc::Client::default();
        let url = format!("http://{address}/api/orgs/{org_id}/members/directory");

        let mut valid = client
            .get(&url)
            .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
            .send()
            .await
            .unwrap();
        assert_eq!(valid.status(), StatusCode::OK);
        let page: serde_json::Value = valid.json().await.unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["name"], "Native Route User");
        let touched: bool = sqlx::query_scalar(
            "SELECT last_used_at IS NOT NULL FROM board_api_keys WHERE id = $1::uuid",
        )
        .bind(&key_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(touched);

        sqlx::query("UPDATE board_api_keys SET revoked_at = now() WHERE id = $1::uuid")
            .bind(&key_id)
            .execute(&pool)
            .await
            .unwrap();
        let revoked = client
            .get(&url)
            .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);

        let unknown = client
            .get(&url)
            .insert_header((
                header::AUTHORIZATION,
                format!("Bearer pcp_unknown_{suffix}"),
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);

        control.stop(true).await;
        task.await.unwrap().unwrap();
        sqlx::query("DELETE FROM board_api_keys WHERE id = $1::uuid")
            .bind(&key_id)
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
        sqlx::query("DELETE FROM organizations WHERE id = $1::uuid")
            .bind(&org_id)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    #[actix_web::test]
    #[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
    async fn native_cookie_session_get_session_and_member_directory_use_current_database_authority()
    {
        let pool = disposable_native_auth_pool().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let org_id: String = sqlx::query_scalar(
            "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
        )
        .bind(format!("native-session-route-{suffix}"))
        .bind(format!("Native session route {suffix}"))
        .bind(format!("S{}", &suffix[..7].to_ascii_uppercase()))
        .fetch_one(&pool)
        .await
        .unwrap();
        let user_id = format!("native-session-user-{suffix}");
        sqlx::query(
            r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
               VALUES ($1, 'Native Session User', $2, now(), now())"#,
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
        let token = format!("native-session-token-{suffix}");
        let session_id = format!("native-session-{suffix}");
        sqlx::query(
            r#"INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
               VALUES ($1, $2, $3, now() + interval '2 days', now(), now())"#,
        )
        .bind(&session_id)
        .bind(&token)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();

        let config = ServerConfig {
            database_url: Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
            actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
            workers: 1,
            ..ServerConfig::default()
        };
        let foundation = Arc::new(AppState::new(config).unwrap());
        let mut ingress_config = PublicIngressConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:1",
            INTERNAL,
        )
        .unwrap();
        ingress_config.session_auth = Some(
            NativeSessionAuthConfig::new(
                NativeSessionAuthKind::BetterAuth,
                SECRET,
                false,
                "session-assertion-key-0123456789abcdef",
            )
            .unwrap(),
        );
        let runtime = PublicIngressRuntime::bind(ingress_config, foundation).unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());
        let client = awc::Client::default();
        let cookie = signed_cookie("better-auth.session_token", &token, SECRET);

        let mut session = client
            .get(format!("http://{address}/api/auth/get-session"))
            .insert_header((header::COOKIE, cookie.as_str()))
            .send()
            .await
            .unwrap();
        assert_eq!(session.status(), StatusCode::OK);
        assert!(session.headers().get(header::SET_COOKIE).is_none());
        let body: serde_json::Value = session.json().await.unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "session": {"id": format!("rudder:session:{user_id}"), "userId": user_id},
                "user": {"id": user_id, "email": null, "name": null},
            })
        );

        let directory_url = format!("http://{address}/api/orgs/{org_id}/members/directory");
        let mut directory = client
            .get(&directory_url)
            .insert_header((header::COOKIE, cookie.as_str()))
            .send()
            .await
            .unwrap();
        assert_eq!(directory.status(), StatusCode::OK);
        let page: serde_json::Value = directory.json().await.unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["name"], "Native Session User");

        sqlx::query(
            "UPDATE organization_memberships SET status = 'inactive' WHERE org_id = $1::uuid AND principal_id = $2",
        )
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        let removed_member = client
            .get(&directory_url)
            .insert_header((header::COOKIE, cookie.as_str()))
            .send()
            .await
            .unwrap();
        assert_eq!(removed_member.status(), StatusCode::FORBIDDEN);

        sqlx::query("DELETE FROM session WHERE id = $1")
            .bind(&session_id)
            .execute(&pool)
            .await
            .unwrap();
        let revoked = client
            .get(format!("http://{address}/api/auth/get-session"))
            .insert_header((header::COOKIE, cookie.as_str()))
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);

        let bearer_wins = client
            .get(format!("http://{address}/api/auth/get-session"))
            .insert_header((header::COOKIE, cookie.as_str()))
            .insert_header((header::AUTHORIZATION, "Bearer pcp_native_session_revoked"))
            .send()
            .await
            .unwrap();
        assert_ne!(bearer_wins.status(), StatusCode::OK);
        control.stop(true).await;
        task.await.unwrap().unwrap();
        pool.close().await;
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

        {
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
        }
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
