//! Public listener with a direct Rust read and an explicit unmigrated proxy.
//! The private foundation router is deliberately not mounted on this socket.

use super::*;
use crate::llm_reflection::{LlmReflectionDocument, LlmReflectionSnapshot};
use crate::native_session_auth::{
    NativeIngressIdentity, NativeSessionIdentity, NativeSessionResolution, issue_assertion,
};
use crate::native_session_revocation::SessionRevocationUpgradeError;
use crate::private_host_gate::NativePrivateHostGate;
use crate::public_ingress_config::{NativeSessionAuthKind, NativeWebSocketCookieFallback};
use crate::public_ingress_proxy::{PRIVATE_LLM_REFLECTION_AUTH_ADAPTER_PATH, PublicIngressProxy};
use crate::public_ingress_websocket::PublicIngressWebSocketProxy;
use actix_web::guard;
use actix_web::http::Method;
use actix_web::http::header::HeaderMap;
use rudder_d1_persistence::goal_reads::{GoalReadRequest, GoalReadView};
use uuid::Uuid;

mod agent_core;
mod approval_reads;
mod browser_session;
mod cli_auth;
mod email_auth;
mod goal_singular_reads;
mod goal_writes;
mod native_chat;
mod organization_resources;
mod project_reads;
mod project_writes;
mod runtime_bindings;

pub(crate) fn ensure_project_organization_workspace_root(org_id: &str) -> Result<String, ()> {
    agent_core::ensure_organization_workspace_root(org_id)
}

const AUTH_PATH: &str = "/api/_internal/rudder-ingress/authorize-member-directory";
const LLM_REFLECTION_AUTH_PATH: &str = PRIVATE_LLM_REFLECTION_AUTH_ADAPTER_PATH;
const LLM_REFLECTION_ACTION: &str = "llm.reflection.read";
const LLM_REFLECTION_SCOPE: &str = "instance";

#[derive(Clone)]
pub(super) struct IngressState {
    pub(super) foundation: Arc<AppState>,
    pub(super) config: PublicIngressConfig,
    pub(super) local_account: Option<crate::local_account_auth::LocalAccountAuthService>,
    pub(super) cli_auth_browser_auth: Option<crate::browser_auth::BrowserAuthConfig>,
}

/// Apply the effective private-host policy before a public request enters a
/// Rust-owned handler. Node's middleware guards ordinary HTTP after JSON body
/// parsing; its WebSocket upgrade listener is outside Express middleware, so
/// the managed public ingress applies the same original-Host rule there too.
pub(crate) fn private_host_rejection(
    state: &IngressState,
    request: &HttpRequest,
) -> Option<HttpResponse> {
    state
        .config
        .private_host_gate
        .as_ref()
        .and_then(|gate: &NativePrivateHostGate| gate.rejection(request))
}

/// `express.json()` runs before Node's private-host middleware. Actix's direct
/// handlers accept raw bytes, so retain parser-error precedence for native
/// handlers that otherwise would reject bodies or authorize first.
pub(crate) fn malformed_public_json_response(
    request: &HttpRequest,
    body: &[u8],
) -> Option<HttpResponse> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let media_type = content_type.split(';').next().unwrap_or_default().trim();
    if !media_type.eq_ignore_ascii_case("application/json") || body.is_empty() {
        return None;
    }
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(value) if value.is_object() || value.is_array() => None,
        _ => Some(HttpResponse::InternalServerError().json(serde_json::json!({
            "error": "Internal server error"
        }))),
    }
}

/// Guard the public boundary before Actix chooses a route or returns 405.
/// For denied hosts retain Express's strict JSON-parser error precedence.
/// Accepted requests keep their original payload and existing parser owner.
async fn enforce_private_host_gate(
    state: web::Data<IngressState>,
    payload: web::Payload,
    mut request: ServiceRequest,
    next: Next<impl MessageBody + 'static>,
) -> Result<actix_web::dev::ServiceResponse<impl MessageBody>, Error> {
    if !matches!(request.path(), "/healthz" | "/readyz")
        && let Some(rejection) = private_host_rejection(&state, request.request())
    {
        let is_json = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            });
        let response = if is_json {
            let supported_encoding = {
                let mut values = request.headers().get_all(header::CONTENT_ENCODING);
                let first = values.next();
                values.next().is_none()
                    && first.is_none_or(|value| {
                        value.to_str().is_ok_and(|value| {
                            matches!(
                                value.trim().to_ascii_lowercase().as_str(),
                                "" | "identity" | "gzip" | "deflate" | "br"
                            )
                        })
                    })
            };
            if !supported_encoding {
                return Ok(request
                    .into_response(HttpResponse::InternalServerError().json(serde_json::json!({
                        "error": "Internal server error"
                    })))
                    .map_into_right_body());
            }
            let stream = actix_web::body::BodyStream::new(
                actix_web::dev::Decompress::from_headers(payload.into_inner(), request.headers()),
            );
            match actix_web::body::to_bytes_limited(stream, 10 * 1024 * 1024).await {
                Ok(Ok(body)) => {
                    malformed_public_json_response(request.request(), &body).unwrap_or(rejection)
                }
                _ => HttpResponse::InternalServerError().json(serde_json::json!({
                    "error": "Internal server error"
                })),
            }
        } else {
            rejection
        };
        return Ok(request.into_response(response).map_into_right_body());
    }
    request.set_payload(payload.into_inner());
    Ok(next.call(request).await?.map_into_left_body())
}

pub struct PublicIngressRuntime {
    server: actix_web::dev::Server,
    handle: actix_web::dev::ServerHandle,
    bound_addr: SocketAddr,
    session_auth_kind: Option<NativeSessionAuthKind>,
    native_identity_enabled: bool,
    local_implicit_enabled: bool,
    local_account_lifecycle_enabled: bool,
    browser_session_auth_enabled: bool,
    better_auth_email_auth_enabled: bool,
}

impl PublicIngressRuntime {
    pub(crate) fn bind(
        config: PublicIngressConfig,
        foundation: Arc<AppState>,
    ) -> Result<Self, ServerError> {
        {
            let mut reader_runtime = foundation
                .native_chat_public_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *reader_runtime = config.native_chat_runtime.clone();
        }
        if foundation.config.actor_envelope_key.is_none() {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_ACTOR_ENVELOPE_KEY",
                "public ingress requires signed authorization",
            )
            .into());
        }
        if let Some(browser_auth) = &config.browser_auth {
            browser_auth
                .validate_listener(config.listen_addr)
                .map_err(|error| {
                    ConfigError::invalid("RUDDER_NATIVE_BROWSER_AUTH_MODE", &error.to_string())
                })?;
            if browser_auth.better_auth_email_auth_enabled() {
                let issuer_settings = browser_auth.better_auth_session_settings();
                let supplied_session = config.session_auth.as_ref();
                if issuer_settings.is_none_or(|(secret, secure)| {
                    supplied_session.is_none_or(|session| {
                        session.kind != NativeSessionAuthKind::BetterAuth
                            || session.secure_cookie != secure
                            || session.secret.as_bytes() != secret
                    })
                }) {
                    return Err(ConfigError::invalid(
                        "RUDDER_NATIVE_BROWSER_AUTH_ISSUER",
                        "native email auth requires the matching Better Auth session issuer",
                    )
                    .into());
                }
            }
        }
        if config.native_chat_runtime.is_some()
            && (config.browser_auth.is_none() || config.native_chat_mutations.is_none())
        {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_CHAT_RUNTIME",
                "explicit browser authentication and mutation Origin policy are required",
            )
            .into());
        }
        let listen_addr = config.listen_addr;
        let session_auth_kind = config.session_auth.as_ref().map(|settings| settings.kind);
        let browser_session_auth_enabled =
            config.browser_auth.is_some() || session_auth_kind.is_some();
        let better_auth_email_auth_enabled = config
            .browser_auth
            .as_ref()
            .is_some_and(|auth| auth.better_auth_email_auth_enabled());
        if config.identity_auth.as_ref().is_some_and(|identity| {
            identity.local_implicit_enabled && !listen_addr.ip().is_loopback()
        }) {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_LOCAL_IMPLICIT",
                "local implicit authentication requires a numeric loopback listener",
            )
            .into());
        }
        if let (Some(identity), Some(session)) =
            (config.identity_auth.as_ref(), config.session_auth.as_ref())
            && identity.assertion_key != session.assertion_key
        {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_IDENTITY_ASSERTION_KEY",
                "must match RUDDER_NATIVE_SESSION_ASSERTION_KEY",
            )
            .into());
        }
        let local_account = if config.local_account_auth.is_some() {
            let DatabaseState::Configured(pool) = &foundation.database else {
                return Err(ConfigError::invalid(
                    "RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG",
                    "local account lifecycle requires a configured database",
                )
                .into());
            };
            config
                .build_local_account_auth_service(pool.clone())
                .map_err(|_| {
                    ConfigError::invalid(
                        "RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG",
                        "local account lifecycle could not be initialized",
                    )
                })?
        } else {
            None
        };
        let cli_auth_browser_auth = cli_auth::browser_auth_from_config(&config)
            .map_err(|reason| ConfigError::invalid("RUDDER_NATIVE_PUBLIC_INGRESS", reason))?;
        let data = web::Data::new(IngressState {
            foundation: foundation.clone(),
            config: config.clone(),
            local_account,
            cli_auth_browser_auth,
        });
        let max_request_bytes = foundation.config.max_request_bytes;
        let workers = foundation.config.workers;
        let shutdown_grace = foundation.config.shutdown_grace.as_secs();
        let native_identity_enabled = config.identity_auth.is_some();
        let session_auth_kind = config.session_auth.as_ref().map(|settings| settings.kind);
        let local_account_lifecycle_enabled = config.local_account_auth.is_some();
        let local_implicit_enabled = config
            .identity_auth
            .as_ref()
            .is_some_and(|identity| identity.local_implicit_enabled);
        let http = HttpServer::new(move || {
            // Client state belongs to its Actix worker; no Send/Sync workaround.
            let proxy = PublicIngressProxy::new(&config.node_upstream)
                .expect("validated fixed loopback upstream")
                .with_forwarding_policy(config.forwarding_policy.clone());
            let websocket_proxy = PublicIngressWebSocketProxy::new(proxy.upstream_authority())
                .expect("validated fixed loopback upstream")
                .with_forwarding_policy(config.forwarding_policy.clone());
            let app = App::new()
                .app_data(data.clone())
                .app_data(web::Data::new(proxy))
                .app_data(web::Data::new(websocket_proxy))
                .app_data(web::PayloadConfig::new(max_request_bytes))
                .wrap(middleware::from_fn(enforce_private_host_gate))
                .wrap(middleware::from_fn(reject_unsupported_websocket_upgrade))
                .configure(|routes| {
                    if config.native_chat_mutations.is_some() {
                        // Send routes also serve exact, read-only replay after
                        // restart. Fresh admission separately requires trusted
                        // host configuration and a reserved worker slot.
                        native_chat::configure(routes, true);
                    }
                    if config.browser_auth.is_some() {
                        routes.route(
                            "/api/auth/get-session",
                            web::route().to(browser_session::get),
                        );
                    }
                    if better_auth_email_auth_enabled {
                        routes
                            .route(
                                "/api/auth/sign-up/email",
                                web::post().to(email_auth::sign_up),
                            )
                            .route(
                                "/api/auth/sign-in/email",
                                web::post().to(email_auth::sign_in),
                            )
                            .route("/api/auth/sign-out", web::post().to(email_auth::sign_out));
                    }
                })
                .route("/healthz", web::get().to(ingress_health))
                .route("/readyz", web::get().to(ingress_readiness))
                .route(
                    "/api/auth/local-exchange",
                    web::route().to(crate::local_account_ingress::local_exchange),
                )
                .route(
                    "/api/auth/local-offline",
                    web::route().to(crate::local_account_ingress::local_offline),
                )
                .route(
                    "/api/auth/local-claim",
                    web::route().to(crate::local_account_ingress::local_claim),
                )
                .route(
                    "/api/auth/local-signout-all",
                    web::route().to(crate::local_account_ingress::local_signout_all),
                )
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
                .service(
                    web::resource("/api/orgs/{org_id}/goals")
                        .route(web::get().to(goal_collection))
                        .route(web::post().to(goal_writes::create)),
                )
                .route(
                    "/api/orgs/{org_id}/goals/workspace",
                    web::get().to(goal_workspace_collection),
                )
                .route(
                    "/api/orgs/{org_id}/goals/assigned",
                    web::get().to(goal_assigned_collection),
                )
                .route(
                    "/api/orgs/{org_id}/projects",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(project_reads::collection),
                )
                .route(
                    "/api/projects/{project_ref}",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(project_reads::detail),
                )
                .route(
                    "/api/orgs/{org_id}/approvals",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(approval_reads::dispatch_alias),
                )
                .route(
                    "/api/approvals/{approval_id}",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(approval_reads::dispatch_alias),
                )
                .route(
                    "/api/approvals/{approval_id}/issues",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(approval_reads::dispatch_alias),
                )
                .route(
                    "/api/issues/{issue_id}/approvals",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(approval_reads::dispatch_alias),
                )
                .route(
                    "/api/orgs/{org_id}/labels",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(approval_reads::dispatch_alias),
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
                );
            let app = if config.identity_auth.is_some() {
                app.route(
                    "/api/orgs/{org_id}/agents",
                    web::route()
                        .guard(guard::Any(guard::Get()).or(guard::Head()))
                        .to(agent_core::roster),
                )
                .route(
                    "/api/agents/{agent_id}/permissions",
                    web::patch().to(agent_core::permissions),
                )
            } else {
                app
            };
            app.default_service(web::to(proxy_request))
        })
        .workers(workers)
        .disable_signals()
        .shutdown_timeout(shutdown_grace)
        .bind(listen_addr)?;
        let bound_addr = *http.addrs().first().ok_or(ServerError::NoBoundAddress)?;
        let server = http.run();
        Ok(Self {
            handle: server.handle(),
            server,
            bound_addr,
            session_auth_kind,
            native_identity_enabled,
            local_account_lifecycle_enabled,
            browser_session_auth_enabled,
            better_auth_email_auth_enabled,
            local_implicit_enabled,
        })
    }

    pub fn bound_addr(&self) -> SocketAddr {
        self.bound_addr
    }
    pub fn startup_receipt(&self) -> serde_json::Value {
        let mut receipt = public_ingress_startup_receipt(
            self.bound_addr,
            self.session_auth_kind,
            self.native_identity_enabled,
            self.local_implicit_enabled,
            self.browser_session_auth_enabled,
            self.better_auth_email_auth_enabled,
        );
        if self.local_account_lifecycle_enabled {
            receipt["localAccountLifecycle"] = serde_json::json!({
                "authority": "rust",
                "protocolVersion": 1,
                "routes": [
                    "/api/auth/local-exchange", "/api/auth/local-offline",
                    "/api/auth/local-claim", "/api/auth/local-signout-all",
                ],
            });
        }
        receipt
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
    native_identity_enabled: bool,
    local_implicit_enabled: bool,
    browser_session_auth_enabled: bool,
    better_auth_email_auth_enabled: bool,
) -> serde_json::Value {
    let mut direct_routes = vec![
        "/api/orgs/:org_id/members/directory",
        "/api/orgs/:org_id/goals",
        "/api/orgs/:org_id/goals/workspace",
        "/api/orgs/:org_id/goals/assigned",
        "/api/orgs/:org_id/resources",
        "/api/orgs/:org_id/resources/:resource_id",
        "/api/orgs/:org_id/intelligence-profiles",
        "/api/orgs/:org_id/approvals",
        "/api/approvals/:approval_id",
        "/api/approvals/:approval_id/issues",
        "/api/issues/:issue_id/approvals",
        "/api/orgs/:org_id/labels",
    ];
    if native_identity_enabled {
        direct_routes.extend([
            "/api/orgs/:org_id/agents",
            "/api/agents/:agent_id/permissions",
            "/api/orgs/:org_id/agent-configurations",
            "/api/orgs/:org_id/agents/name-suggestion",
            "/api/agents/:agent_id/configuration",
            "/api/agents/:agent_id/config-revisions",
            "/api/agents/:agent_id/config-revisions/:revision_id",
            "/api/agents/:agent_id/config-revisions/:revision_id/rollback",
        ]);
    }
    if session_auth_kind.is_some() {
        direct_routes.push("/api/auth/get-session");
    }
    if better_auth_email_auth_enabled {
        direct_routes.extend([
            "/api/auth/sign-up/email",
            "/api/auth/sign-in/email",
            "/api/auth/sign-out",
        ]);
    }
    let mut native_authentication = serde_json::json!({
        "authority": if native_identity_enabled { "native-managed-http-identity-resolver" } else { "native-pcp-bearer-resolver" },
        "recognizedBearerPrefix": if native_identity_enabled { serde_json::Value::Null } else { serde_json::json!("pcp_") },
        "supportedCredentialStores": if native_identity_enabled { vec!["board_api_keys", "agent_api_keys", "agent_jwt"] } else { vec!["board_api_keys", "agent_api_keys"] },
        "directRoutes": direct_routes,
        "recognizedInvalidCredentialsFailClosed": true,
        "localImplicitEnabled": native_identity_enabled && local_implicit_enabled,
        "localImplicitConstraint": if native_identity_enabled && local_implicit_enabled { "numeric_loopback_listener_and_actual_peer" } else { "disabled" },
        "identityAssertionTransport": if native_identity_enabled { "one_time_method_target_bound_loopback_hmac" } else { "disabled" },
        "nodeRechecksCurrentOrganizationRolesAndMemberships": true,
        "unmigrated": if better_auth_email_auth_enabled { vec!["remaining_auth_wildcard_routes", "websocket_session_resolution"] } else { vec!["auth_lifecycle_routes", "websocket_session_resolution"] },
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
            "unmigrated": if better_auth_email_auth_enabled { vec!["remaining_auth_wildcard_routes", "websocket_session_resolution"] } else { vec!["auth_lifecycle_routes", "websocket_session_resolution"] },
        });
    }
    serde_json::json!({
        "boundAddr": bound_addr,
        "publicListener": true,
        "directAuthorities": if native_identity_enabled {
            vec!["native_managed_http_identity_resolver", "native_session_cookie_resolver", "native_agent_jwt_resolver", "native_local_implicit_policy"]
        } else if session_auth_kind.is_some() {
            vec!["native_pcp_bearer_resolver", "native_session_cookie_resolver"]
        } else {
            vec!["native_pcp_bearer_resolver"]
        },
        "nativeAuthentication": native_authentication,
        "browserSessionAuthentication": {
            "enabled": browser_session_auth_enabled,
            "authority": if session_auth_kind.is_some() {
                "native-existing-session-cookie-resolver"
            } else {
                "native-browser-session-resolver"
            },
            "route": "GET /api/auth/get-session",
            "nativeFailureFallback": false,
            "scope": if session_auth_kind.is_some() {
                "public_ingress_non_lifecycle_http_without_bearer"
            } else {
                "session-read-only; other compatibility routes retain their existing authentication"
            },
        },
        "nativeEmailPasswordLifecycle": if better_auth_email_auth_enabled {
            serde_json::json!({
                "authority": "rust",
                "routes": [
                    "POST /api/auth/sign-up/email",
                    "POST /api/auth/sign-in/email",
                    "POST /api/auth/sign-out",
                ],
                "remainingAuthWildcard": "explicit-private-node-proxy",
            })
        } else {
            serde_json::Value::Null
        },
        "nativeCliBoardAuthentication": {
            "authority": "rust",
            "protocolVersion": 1,
            "routes": [
                "POST /api/cli-auth/challenges",
                "GET /api/cli-auth/challenges/:id",
                "POST /api/cli-auth/challenges/:id/approve",
                "POST /api/cli-auth/challenges/:id/cancel",
                "GET /api/cli-auth/me",
                "POST /api/cli-auth/revoke-current",
            ],
            "privateNodeFallback": false,
            "usesExistingBoardApiKeys": true,
        },
        "compatibilityAuthentication": {
            "authority": if native_identity_enabled { "none_for_managed_http_identity" } else { "private-node-adapter" },
            "credentialForms": if native_identity_enabled { vec!["auth lifecycle routes", "websocket session resolution"] } else { vec!["local Agent JWTs", "local-trusted and local-implicit identities", "non-pcp_ bearer credentials", "Bearer-authenticated HTTP requests"] },
            "nodeOwnedRoutes": if better_auth_email_auth_enabled { vec!["remaining_auth_wildcard_routes", "websocket_session_resolution"] } else { vec!["auth_lifecycle_routes", "websocket_session_resolution"] },
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
    let assertion_key = state
        .config
        .identity_auth
        .as_ref()
        .map(|auth| auth.assertion_key.as_str())
        .or_else(|| {
            state
                .config
                .session_auth
                .as_ref()
                .map(|auth| auth.assertion_key.as_str())
        });
    if let Some(assertion_key) = assertion_key {
        // Readiness is an internal anonymous request, subject to the same
        // private-hop proof guard as public requests, including identity-only
        // configurations without Cookie session authority.
        let anonymous = NativeIngressIdentity::None;
        let proof = match issue_assertion(assertion_key, "GET", "/api/health", &anonymous) {
            Ok(proof) => proof,
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_session_assertion_unavailable",
                );
            }
        };
        probe = probe.insert_header(("x-rudder-native-session-proof", proof));
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
    // Express matches route literals case-insensitively and permits a trailing
    // slash. Actix's explicit routes above retain the common spelling; route
    // aliases are dispatched here so they remain native and never fall back.
    if project_reads::is_reserved_path(request.uri().path(), request.method()) {
        return project_reads::dispatch_alias(state, request, payload).await;
    }
    if approval_reads::is_reserved_path(request.uri().path(), request.method()) {
        return approval_reads::dispatch_alias(state, request, payload).await;
    }
    if project_writes::is_reserved_path(request.uri().path()) {
        return project_writes::dispatch_alias(state, request, payload).await;
    }
    if goal_writes::is_reserved_path(request.uri().path(), request.method()) {
        return goal_writes::dispatch_alias(state, request, payload).await;
    }
    if agent_core::is_detail_path(request.uri().path(), request.method())
        || (state.config.identity_auth.is_some()
            && agent_core::is_reserved_path(request.uri().path(), request.method()))
    {
        return agent_core::dispatch_alias(state, request, payload).await;
    }
    if let Some(endpoint) = crate::local_account_ingress::endpoint_for_path(request.uri().path()) {
        return crate::local_account_ingress::handle(state, request, payload, endpoint).await;
    }
    if state
        .config
        .browser_auth
        .as_ref()
        .is_some_and(|auth| auth.better_auth_email_auth_enabled())
        && let Some(endpoint) = email_auth::endpoint_for_path(request.uri().path())
    {
        return email_auth::handle(state, request, payload, endpoint).await;
    }
    if let Some(endpoint) =
        organization_resources::endpoint_for_path(request.uri().path(), request.method())
    {
        return organization_resources::handle(state, request, payload, endpoint).await;
    }
    if let Some(endpoint) = cli_auth::endpoint_for_path(request.uri().path()) {
        return cli_auth::handle(state, request, payload, endpoint).await;
    }

    if is_get_session_path(&request) {
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            let mut response = state
                .foundation
                .json_error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
            response
                .headers_mut()
                .insert(header::ALLOW, header::HeaderValue::from_static("GET, HEAD"));
            return response;
        }
        if !request.headers().contains_key(header::AUTHORIZATION)
            && state.config.session_auth.is_some()
            && crate::native_session_auth::has_session_cookie(request.headers())
        {
            return get_session(state, request).await;
        }
    }
    if let Some((reference, view)) = goal_singular_reads::classify(&request) {
        return goal_singular_reads::dispatch(state, request, payload, reference, view).await;
    }
    if let Some((org_id, view, assigned)) = public_goal_collection_route(&request) {
        return goal_collection_proxy_alias(state, request, payload, org_id, view, assigned).await;
    }
    if is_goal_collection_namespace(&request)
        && matches!(*request.method(), Method::GET | Method::HEAD)
    {
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    }
    // Express's compatibility router is case-insensitive and accepts an
    // optional trailing slash. Never let a near-match under this namespace
    // fall back to Node in required-Rust mode: exact migrated routes are
    // handled above, and every remaining /llms path is deliberately closed.
    if (state.config.browser_auth.is_some() && browser_session::reserved_path(request.uri().path()))
        || (state
            .config
            .browser_auth
            .as_ref()
            .is_some_and(|auth| auth.better_auth_email_auth_enabled())
            && email_auth::reserved_path(request.uri().path()))
        || cli_auth::reserved_path(request.uri().path())
        || organization_resources::reserved_path(request.uri().path())
        || project_writes::is_reserved_path(request.uri().path())
        || goal_writes::is_reserved_path(request.uri().path(), request.method())
        || native_chat::capability_path(request.uri().path())
        || native_chat::runtime_check_path(request.uri().path())
        || (state.config.native_chat_mutations.is_some()
            && native_chat::reserved_path(request.uri().path()))
        || runtime_bindings::reserved_path(request.uri().path())
        || request
            .uri()
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .is_some_and(|segment| segment.eq_ignore_ascii_case("llms"))
    {
        if cli_auth::reserved_path(request.uri().path()) {
            return cli_auth::reserved_not_found(&state);
        }
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    }

    if has_websocket_upgrade(request.headers()) {
        if is_supported_websocket_upgrade_route(&request) {
            if let Some(response) = private_host_rejection(&state, &request) {
                return response;
            }
            if let Some(session_auth) = state.config.session_auth.as_ref()
                && selected_local_account_websocket_session(
                    &request,
                    session_auth,
                    state.config.websocket_cookie_fallback,
                )
            {
                // Capture the registry cursor before resolving the cookie. A
                // sign-out that commits during this database await is then
                // observed by bind(), which either rejects this upgrade or
                // atomically registers it for close-on-revocation.
                let pending = match state.foundation.session_revocation.begin_upgrade() {
                    Ok(pending) => pending,
                    Err(_) => {
                        return state.foundation.json_error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "websocket_session_revocation_capacity_exhausted",
                        );
                    }
                };
                match state
                    .foundation
                    .resolve_public_session(session_auth, request.headers())
                    .await
                {
                    NativeSessionResolution::Authenticated(identity) => {
                        let registration = match pending.bind(&identity.user_id) {
                            Ok(registration) => registration,
                            Err(SessionRevocationUpgradeError::RevokedDuringAuthorization) => {
                                return state
                                    .foundation
                                    .json_error(StatusCode::FORBIDDEN, "account_session_changed");
                            }
                            Err(SessionRevocationUpgradeError::RevocationHistoryExpired) => {
                                return state.foundation.json_error(
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    "websocket_session_revocation_history_exhausted",
                                );
                            }
                            Err(SessionRevocationUpgradeError::CapacityExceeded) => {
                                return state.foundation.json_error(
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    "websocket_session_revocation_capacity_exhausted",
                                );
                            }
                        };
                        return websocket_proxy
                            .forward_with_session_revocation(request, payload, registration)
                            .await;
                    }
                    NativeSessionResolution::Anonymous => {
                        // Keep Node's existing WebSocket authorizer decisive
                        // for invalid or expired cookies.
                        drop(pending);
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
                }
            }
            return websocket_proxy.forward(request, payload).await;
        }
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    }
    if is_node_owned_lifecycle_route(&request) {
        return proxy.forward(request, payload).await;
    }
    if let Some(identity_auth) = state.config.identity_auth.as_ref() {
        let identity = match resolve_public_http_identity(&state, &request).await {
            Ok(identity) => identity,
            Err((status, code)) => return state.foundation.json_error(status, code),
        };
        if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
            return response;
        }
        let Some(path_and_query) = request.uri().path_and_query() else {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "invalid_request_target");
        };
        let proof = match issue_assertion(
            &identity_auth.assertion_key,
            request.method().as_str(),
            path_and_query.as_str(),
            &identity,
        ) {
            Ok(proof) => proof,
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_identity_assertion_unavailable",
                );
            }
        };
        return proxy
            .forward_with_session_assertion(
                request,
                payload,
                Some(&proof),
                state.config.session_auth.as_ref(),
            )
            .await;
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
    let assertion_identity = identity
        .map(NativeIngressIdentity::Session)
        .unwrap_or(NativeIngressIdentity::None);
    let proof = match issue_assertion(
        &session_auth.assertion_key,
        request.method().as_str(),
        path_and_query.as_str(),
        &assertion_identity,
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

/// Forward a request through the authenticated compatibility path after a
/// Rust-owned Native target has explicitly declined it. Native failures must
/// never silently select this transport.
pub(super) async fn forward_compatibility(
    state: web::Data<IngressState>,
    proxy: web::Data<PublicIngressProxy>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
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
    let assertion_identity = identity
        .map(NativeIngressIdentity::Session)
        .unwrap_or(NativeIngressIdentity::None);
    let proof = match issue_assertion(
        &session_auth.assertion_key,
        request.method().as_str(),
        path_and_query.as_str(),
        &assertion_identity,
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

pub(super) async fn resolve_public_http_identity(
    state: &IngressState,
    request: &HttpRequest,
) -> Result<NativeIngressIdentity, (StatusCode, &'static str)> {
    let identity_auth = state.config.identity_auth.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "native_identity_unavailable",
    ))?;

    if let Some(token) =
        authorization_bearer(request).map_err(|_| (StatusCode::UNAUTHORIZED, "unauthorized"))?
    {
        return match state
            .foundation
            .resolve_public_bearer(token, None, &identity_auth.agent_jwt)
            .await
        {
            native_bearer_auth::NativeBearerResolution::Authorized { proof_identity, .. } => {
                Ok(*proof_identity)
            }
            native_bearer_auth::NativeBearerResolution::Forbidden => {
                Err((StatusCode::FORBIDDEN, "forbidden"))
            }
            native_bearer_auth::NativeBearerResolution::Unauthorized
            | native_bearer_auth::NativeBearerResolution::Compatibility => {
                Err((StatusCode::UNAUTHORIZED, "unauthorized"))
            }
            native_bearer_auth::NativeBearerResolution::DatabaseDisabled => {
                Err((StatusCode::SERVICE_UNAVAILABLE, "database_disabled"))
            }
            native_bearer_auth::NativeBearerResolution::Unavailable => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "native_identity_unavailable",
            )),
        };
    }

    if crate::native_session_auth::has_session_cookie(request.headers()) {
        let Some(session_auth) = state.config.session_auth.as_ref() else {
            return Err((StatusCode::UNAUTHORIZED, "unauthorized"));
        };
        return match state
            .foundation
            .resolve_public_session(session_auth, request.headers())
            .await
        {
            NativeSessionResolution::Authenticated(identity) => {
                Ok(NativeIngressIdentity::Session(identity))
            }
            // A supplied but invalid, expired, duplicated or revoked session
            // cookie is never reinterpreted as a local-trusted request.
            NativeSessionResolution::Anonymous => Err((StatusCode::UNAUTHORIZED, "unauthorized")),
            NativeSessionResolution::DatabaseDisabled => {
                Err((StatusCode::SERVICE_UNAVAILABLE, "database_disabled"))
            }
            NativeSessionResolution::Unavailable => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "native_session_unavailable",
            )),
        };
    }

    if identity_auth.local_implicit_enabled
        && state.config.listen_addr.ip().is_loopback()
        && request
            .peer_addr()
            .is_some_and(|peer| peer.ip().is_loopback())
    {
        return Ok(NativeIngressIdentity::LocalImplicit);
    }

    Ok(NativeIngressIdentity::None)
}

fn agent_run_id_header(request: &HttpRequest) -> Option<String> {
    let mut values = request.headers().get_all("x-rudder-run-id");
    let value = values.next()?;
    // Node's legacy auth compares one normalized header value with the signed
    // JWT run id. Reject ambiguous duplicate values and trim HTTP optional
    // whitespace before the same comparison.
    if values.next().is_some() {
        return Some(String::new());
    }
    let normalized = value.to_str().map(str::trim).unwrap_or_default();
    (!normalized.is_empty()).then(|| normalized.to_owned())
}

pub(super) fn agent_run_context_mismatch_response(
    request: &HttpRequest,
    identity: &NativeIngressIdentity,
) -> Option<HttpResponse> {
    let NativeIngressIdentity::AgentJwt(identity) = identity else {
        return None;
    };
    let requested_run_id = agent_run_id_header(request)?;
    (requested_run_id != identity.run_id).then(|| {
        HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Agent run header does not match the signed runtime context",
            "code": "agent_run_context_mismatch",
            "details": {
                "signedRunId": identity.run_id,
                "requestedRunId": requested_run_id,
            },
        }))
    })
}

async fn reject_unsupported_websocket_upgrade(
    state: web::Data<IngressState>,
    request: ServiceRequest,
    next: Next<impl MessageBody + 'static>,
) -> Result<actix_web::dev::ServiceResponse<impl MessageBody>, Error> {
    if has_websocket_upgrade(request.request().headers())
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

fn has_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::UPGRADE)
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|protocol| protocol.trim().eq_ignore_ascii_case("websocket"))
}

fn is_get_session_path(request: &HttpRequest) -> bool {
    request
        .uri()
        .path()
        .trim_end_matches('/')
        .eq_ignore_ascii_case("/api/auth/get-session")
}

fn is_node_owned_lifecycle_route(request: &HttpRequest) -> bool {
    if is_get_session_path(request) {
        return false;
    }
    let path = request
        .uri()
        .path()
        .trim_end_matches('/')
        .to_ascii_lowercase();
    path == "/api/auth" || path.starts_with("/api/auth/")
}

fn authorization_bearer(request: &HttpRequest) -> Result<Option<&str>, ()> {
    let mut values = request.headers().get_all(header::AUTHORIZATION);
    if values.next().is_none() {
        return Ok(None);
    }
    if request.headers().get_all(header::AUTHORIZATION).count() != 1 {
        return Err(());
    }
    let value = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(())?;
    let (scheme, token) = value.split_once(' ').ok_or(())?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return Err(());
    }
    let token = token.trim();
    if token.is_empty() {
        return Err(());
    }
    Ok(Some(token))
}

fn has_bearer_header(request: &HttpRequest) -> bool {
    authorization_bearer(request).ok().flatten().is_some()
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

fn selected_local_account_websocket_session(
    request: &HttpRequest,
    session_auth: &crate::public_ingress_config::NativeSessionAuthConfig,
    cookie_fallback: NativeWebSocketCookieFallback,
) -> bool {
    if session_auth.kind != NativeSessionAuthKind::LocalAccount
        || cookie_fallback == NativeWebSocketCookieFallback::LocalTrustedImplicit
        || !crate::native_session_auth::has_session_cookie(request.headers())
    {
        return false;
    }

    let authorization = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let has_bearer = authorization.is_some_and(|value| {
        value
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
            && value.get(7..).is_some_and(|token| !token.trim().is_empty())
    });
    if has_bearer {
        return false;
    }

    let has_query_token = request.uri().query().is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == "token")
            .is_some_and(|(_, token)| !token.trim().is_empty())
    });
    !has_query_token
}

async fn get_session(state: web::Data<IngressState>, request: HttpRequest) -> HttpResponse {
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    let Some(session_auth) = state.config.session_auth.as_ref() else {
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    };
    let mut response = match state
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
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

fn goal_query_value(request: &HttpRequest, key: &str) -> Option<String> {
    let mut values = request.uri().query().into_iter().flat_map(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .filter(|(candidate, _)| candidate == key)
            .map(|(_, value)| value.into_owned())
    });
    let value = values.next()?;
    // Express's `req.query` represents duplicate keys as arrays. The Node
    // optionalQueryString helper rejects those by returning null; preserve
    // that contract on the native public ingress instead of selecting a value.
    if values.next().is_some() {
        return None;
    }
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn goal_query_number(value: &str) -> Option<f64> {
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16)
            .ok()
            .map(|number| number as f64);
    }
    if let Some(binary) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        return u64::from_str_radix(binary, 2)
            .ok()
            .map(|number| number as f64);
    }
    if let Some(octal) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        return u64::from_str_radix(octal, 8)
            .ok()
            .map(|number| number as f64);
    }
    value.parse::<f64>().ok()
}

#[allow(clippy::result_large_err)]
fn goal_assigned_input(
    request: &HttpRequest,
    agent_id: String,
) -> Result<GoalReadRequest, HttpResponse> {
    let lifecycle = goal_query_value(request, "lifecycle").unwrap_or_else(|| "active".into());
    if !matches!(lifecycle.as_str(), "draft" | "active" | "closed" | "all") {
        return Err(HttpResponse::BadRequest().json(serde_json::json!({
            "error":"Goal lifecycle must be draft, active, closed, or all"
        })));
    }
    let focus = match goal_query_value(request, "focus").as_deref() {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => {
            return Err(HttpResponse::BadRequest().json(serde_json::json!({
                "error":"Goal focus must be true or false"
            })));
        }
    };
    let facet = goal_query_value(request, "facet");
    if facet.as_deref().is_some_and(|value| {
        !matches!(
            value,
            "agent_advancing"
                | "waiting_external"
                | "waiting_focus"
                | "needs_attention"
                | "ready_for_acceptance"
                | "closed"
        )
    }) {
        return Err(
            HttpResponse::BadRequest().json(serde_json::json!({"error":"Goal facet is invalid"}))
        );
    }
    let limit = match goal_query_value(request, "limit") {
        None => 20,
        Some(value) => match goal_query_number(&value) {
            Some(value)
                if value.is_finite() && value.fract() == 0.0 && (1.0..=100.0).contains(&value) =>
            {
                value as u16
            }
            _ => {
                return Err(HttpResponse::BadRequest().json(serde_json::json!({
                    "error":"Goal list limit must be between 1 and 100"
                })));
            }
        },
    };
    Ok(GoalReadRequest {
        view: GoalReadView::Assigned,
        goal_id: None,
        cursor: None,
        limit: Some(limit.to_string()),
        agent_id: Some(agent_id),
        lifecycle: Some(lifecycle),
        focus,
        facet,
    })
}

async fn goal_collection(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    goal_collection_read(
        state,
        request,
        body,
        org_id.into_inner(),
        GoalReadView::List,
        false,
    )
    .await
}

async fn goal_workspace_collection(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    goal_collection_read(
        state,
        request,
        body,
        org_id.into_inner(),
        GoalReadView::WorkspaceCards,
        false,
    )
    .await
}

async fn goal_assigned_collection(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    goal_collection_read(
        state,
        request,
        body,
        org_id.into_inner(),
        GoalReadView::Assigned,
        true,
    )
    .await
}

async fn goal_collection_read(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: String,
    view: GoalReadView,
    assigned: bool,
) -> HttpResponse {
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let identity = if state.config.identity_auth.is_some() {
        match resolve_public_http_identity(&state, &request).await {
            Ok(identity) => identity,
            Err((status, code)) => return state.foundation.json_error(status, code),
        }
    } else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if assigned && matches!(identity, NativeIngressIdentity::None) {
        return state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let input = match (&view, identity_agent_id(&identity), assigned) {
        (GoalReadView::Assigned, Some(agent_id), true) => {
            match goal_assigned_input(&request, agent_id.to_owned()) {
                Ok(input) => input,
                Err(response) => return response,
            }
        }
        (GoalReadView::Assigned, _, true) => {
            return HttpResponse::Forbidden()
                .json(serde_json::json!({"error":"Agent authentication required for Goal runtime context"}));
        }
        _ => GoalReadRequest {
            view,
            goal_id: None,
            cursor: None,
            limit: None,
            agent_id: None,
            lifecycle: None,
            focus: None,
            facet: None,
        },
    };
    dispatch_goal_collection_read(&state, &org_id, &input, identity).await
}

fn public_goal_collection_route(request: &HttpRequest) -> Option<(String, GoalReadView, bool)> {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return None;
    }
    let segments = request
        .uri()
        .path()
        .trim_end_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if segments.len() < 5
        || !segments[1].eq_ignore_ascii_case("api")
        || !segments[2].eq_ignore_ascii_case("orgs")
        || segments[3].is_empty()
        || !segments[4].eq_ignore_ascii_case("goals")
    {
        return None;
    }
    match segments.as_slice() {
        ["", _, _, org_id, _] => Some(((*org_id).to_owned(), GoalReadView::List, false)),
        ["", _, _, org_id, _, suffix] if suffix.eq_ignore_ascii_case("workspace") => {
            Some(((*org_id).to_owned(), GoalReadView::WorkspaceCards, false))
        }
        ["", _, _, org_id, _, suffix] if suffix.eq_ignore_ascii_case("assigned") => {
            Some(((*org_id).to_owned(), GoalReadView::Assigned, true))
        }
        _ => None,
    }
}

async fn goal_collection_proxy_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
    org_id: String,
    view: GoalReadView,
    assigned: bool,
) -> HttpResponse {
    let body =
        match actix_web::body::to_bytes(actix_web::body::BodyStream::new(payload.into_inner()))
            .await
        {
            Ok(body) => body,
            Err(_) => {
                return state
                    .foundation
                    .json_error(StatusCode::INTERNAL_SERVER_ERROR, "request_body_invalid");
            }
        };
    goal_collection_read(state, request, body, org_id, view, assigned).await
}

fn is_goal_collection_namespace(request: &HttpRequest) -> bool {
    let segments = request
        .uri()
        .path()
        .trim_end_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    segments.len() >= 5
        && segments[1].eq_ignore_ascii_case("api")
        && segments[2].eq_ignore_ascii_case("orgs")
        && !segments[3].is_empty()
        && segments[4].eq_ignore_ascii_case("goals")
}

fn identity_agent_id(identity: &NativeIngressIdentity) -> Option<&str> {
    match identity {
        NativeIngressIdentity::AgentKey { agent_id, .. }
        | NativeIngressIdentity::AgentJwt(crate::native_agent_jwt::NativeAgentJwtIdentity {
            agent_id,
            ..
        }) => Some(agent_id.as_str()),
        _ => None,
    }
}

async fn dispatch_goal_collection_read(
    state: &IngressState,
    org_id: &str,
    input: &GoalReadRequest,
    identity: NativeIngressIdentity,
) -> HttpResponse {
    match identity {
        NativeIngressIdentity::Session(identity) => {
            state
                .foundation
                .goal_read_with_native_session(
                    org_id,
                    input,
                    &identity,
                    state
                        .config
                        .session_auth
                        .as_ref()
                        .map_or(NativeSessionAuthKind::BetterAuth, |config| config.kind),
                )
                .await
        }
        NativeIngressIdentity::BoardKey {
            user_id,
            key_id,
            token_hash,
        } => {
            let Ok(actor) = ActorIdentity::new("user", &user_id) else {
                return state
                    .foundation
                    .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
            };
            state
                .foundation
                .goal_read_with_native_bearer(
                    org_id,
                    input,
                    &actor,
                    &format!("board-key:{key_id}"),
                    &token_hash,
                )
                .await
        }
        NativeIngressIdentity::AgentKey {
            agent_id,
            key_id,
            token_hash,
            ..
        } => {
            let Ok(actor) = ActorIdentity::new("agent", &agent_id) else {
                return state
                    .foundation
                    .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
            };
            state
                .foundation
                .goal_read_with_native_bearer(
                    org_id,
                    input,
                    &actor,
                    &format!("agent-key:{key_id}"),
                    &token_hash,
                )
                .await
        }
        NativeIngressIdentity::AgentJwt(identity) => {
            state
                .foundation
                .goal_read_with_native_agent_jwt(org_id, input, &identity)
                .await
        }
        NativeIngressIdentity::LocalImplicit => {
            state
                .foundation
                .goal_read_with_native_implicit_board(org_id, input)
                .await
        }
        NativeIngressIdentity::None => state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
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
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
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
    if state.config.identity_auth.is_some() {
        let identity = match resolve_public_http_identity(&state, &request).await {
            Ok(identity) => identity,
            Err((status, code)) => return state.foundation.json_error(status, code),
        };
        if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
            return response;
        }
        return match identity {
            NativeIngressIdentity::Session(identity) => {
                state
                    .foundation
                    .organization_member_directory_with_native_session(
                        org_id.as_str(),
                        query.into_inner(),
                        &identity,
                        state
                            .config
                            .session_auth
                            .as_ref()
                            .map_or(NativeSessionAuthKind::BetterAuth, |config| config.kind),
                    )
                    .await
            }
            NativeIngressIdentity::BoardKey {
                user_id,
                key_id,
                token_hash,
            } => {
                let actor = match ActorIdentity::new("user", &user_id) {
                    Ok(actor) => actor,
                    Err(_) => {
                        return state
                            .foundation
                            .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
                    }
                };
                let session_id = format!("board-key:{key_id}");
                state
                    .foundation
                    .organization_member_directory_with_native_auth(
                        org_id.as_str(),
                        query.into_inner(),
                        Some((&actor, &session_id, &token_hash)),
                    )
                    .await
            }
            NativeIngressIdentity::AgentKey {
                agent_id,
                key_id,
                token_hash,
                ..
            } => {
                let actor = match ActorIdentity::new("agent", &agent_id) {
                    Ok(actor) => actor,
                    Err(_) => {
                        return state
                            .foundation
                            .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
                    }
                };
                let session_id = format!("agent-key:{key_id}");
                state
                    .foundation
                    .organization_member_directory_with_native_auth(
                        org_id.as_str(),
                        query.into_inner(),
                        Some((&actor, &session_id, &token_hash)),
                    )
                    .await
            }
            NativeIngressIdentity::AgentJwt(identity) => {
                state
                    .foundation
                    .organization_member_directory_with_native_agent_jwt(
                        org_id.as_str(),
                        query.into_inner(),
                        &identity,
                    )
                    .await
            }
            NativeIngressIdentity::LocalImplicit => {
                state
                    .foundation
                    .organization_member_directory_with_native_implicit_board(
                        org_id.as_str(),
                        query.into_inner(),
                    )
                    .await
            }
            NativeIngressIdentity::None => state
                .foundation
                .json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
        };
    }
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
                ..
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
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
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
    let public_method = request.method().as_str();
    let mut session_proof = None;
    let mut strip_auth_cookies = None;
    if let Some(identity_auth) = state.config.identity_auth.as_ref() {
        let identity = match resolve_public_http_identity(&state, &request).await {
            Ok(identity) => identity,
            Err((status, code)) => return state.foundation.json_error(status, code),
        };
        if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
            return response;
        }
        session_proof = match issue_assertion(
            &identity_auth.assertion_key,
            Method::GET.as_str(),
            LLM_REFLECTION_AUTH_PATH,
            &identity,
        ) {
            Ok(proof) => Some(proof),
            Err(_) => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_identity_assertion_unavailable",
                );
            }
        };
        strip_auth_cookies = state.config.session_auth.as_ref();
    } else if !has_bearer_header(&request)
        && let Some(session_auth) = state.config.session_auth.as_ref()
    {
        let identity = if crate::native_session_auth::has_session_cookie(request.headers()) {
            match state
                .foundation
                .resolve_public_session(session_auth, request.headers())
                .await
            {
                NativeSessionResolution::Authenticated(identity) => Some(identity),
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
            }
        } else {
            None
        };
        let assertion_identity = identity
            .map(NativeIngressIdentity::Session)
            .unwrap_or(NativeIngressIdentity::None);
        session_proof = match issue_assertion(
            &session_auth.assertion_key,
            Method::GET.as_str(),
            LLM_REFLECTION_AUTH_PATH,
            &assertion_identity,
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
        if name == "authorization" && session_proof.is_some() {
            continue;
        }
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
    use std::{env, str::FromStr, time::Instant};
    use uuid::Uuid;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    const INTERNAL: &str = "fedcba9876543210fedcba9876543210";
    type HmacSha256 = Hmac<Sha256>;

    #[actix_web::test]
    async fn websocket_revocation_binds_only_when_node_selects_local_account_cookie() {
        let local_account = NativeSessionAuthConfig::new(
            NativeSessionAuthKind::LocalAccount,
            "local-account-session-secret",
            false,
            INTERNAL,
        )
        .unwrap();
        let better_auth = NativeSessionAuthConfig::new(
            NativeSessionAuthKind::BetterAuth,
            "better-auth-session-secret",
            false,
            INTERNAL,
        )
        .unwrap();
        let cookie = (header::COOKIE, "better-auth.session_token=signed-session");

        let cookie_only = test::TestRequest::get()
            .uri("/api/orgs/org-1/events/ws")
            .insert_header(cookie.clone())
            .to_http_request();
        assert!(selected_local_account_websocket_session(
            &cookie_only,
            &local_account,
            NativeWebSocketCookieFallback::SessionCookie
        ));

        let bearer_and_cookie = test::TestRequest::get()
            .uri("/api/orgs/org-1/events/ws")
            .insert_header(cookie.clone())
            .insert_header((header::AUTHORIZATION, "Bearer agent-api-key"))
            .to_http_request();
        assert!(!selected_local_account_websocket_session(
            &bearer_and_cookie,
            &local_account,
            NativeWebSocketCookieFallback::SessionCookie
        ));

        let query_token_and_cookie = test::TestRequest::get()
            .uri("/api/orgs/org-1/events/ws?token=agent-api-key")
            .insert_header(cookie.clone())
            .to_http_request();
        assert!(!selected_local_account_websocket_session(
            &query_token_and_cookie,
            &local_account,
            NativeWebSocketCookieFallback::SessionCookie
        ));

        let empty_first_query_token_and_cookie = test::TestRequest::get()
            .uri("/api/orgs/org-1/events/ws?token=%20&token=agent-api-key")
            .insert_header(cookie.clone())
            .to_http_request();
        assert!(selected_local_account_websocket_session(
            &empty_first_query_token_and_cookie,
            &local_account,
            NativeWebSocketCookieFallback::SessionCookie
        ));

        assert!(!selected_local_account_websocket_session(
            &cookie_only,
            &local_account,
            NativeWebSocketCookieFallback::LocalTrustedImplicit
        ));
        assert!(!selected_local_account_websocket_session(
            &cookie_only,
            &better_auth,
            NativeWebSocketCookieFallback::SessionCookie
        ));
    }

    fn signed_cookie(name: &str, token: &str, secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(token.as_bytes());
        let signed = format!("{token}.{}", STANDARD.encode(mac.finalize().into_bytes()));
        let encoded =
            percent_encoding::utf8_percent_encode(&signed, percent_encoding::NON_ALPHANUMERIC);
        format!("{name}={encoded}")
    }

    #[actix_web::test]
    async fn goal_query_optional_strings_match_node_blank_and_duplicate_contract() {
        let agent = "20000000-0000-4000-8000-000000000001".to_owned();
        for query in [
            "lifecycle=%20%20&focus=%20&facet=%20&limit=%20",
            "lifecycle=closed&lifecycle=active&focus=true&focus=false&facet=closed&facet=all&limit=7&limit=8",
        ] {
            let request = test::TestRequest::get()
                .uri(&format!("/api/orgs/org-1/goals/assigned?{query}"))
                .to_http_request();
            let input = goal_assigned_input(&request, agent.clone()).unwrap();
            assert_eq!(input.lifecycle.as_deref(), Some("active"));
            assert_eq!(input.focus, None);
            assert_eq!(input.facet, None);
            assert_eq!(input.limit.as_deref(), Some("20"));
        }
    }

    #[actix_web::test]
    async fn goal_query_limit_matches_node_number_formats_and_bounds() {
        let agent = "20000000-0000-4000-8000-000000000001".to_owned();
        for (raw, expected) in [
            ("0x10", 16),
            ("0b10", 2),
            ("0o10", 8),
            ("1e2", 100),
            ("1.0", 1),
            ("+1", 1),
        ] {
            let request = test::TestRequest::get()
                .uri(&format!("/api/orgs/org-1/goals/assigned?limit={raw}"))
                .to_http_request();
            let input = goal_assigned_input(&request, agent.clone()).unwrap();
            let expected = expected.to_string();
            assert_eq!(input.limit.as_deref(), Some(expected.as_str()));
        }
        for raw in ["0", "101", "1.5", "Infinity", "NaN"] {
            let request = test::TestRequest::get()
                .uri(&format!("/api/orgs/org-1/goals/assigned?limit={raw}"))
                .to_http_request();
            assert_eq!(
                goal_assigned_input(&request, agent.clone())
                    .unwrap_err()
                    .status(),
                StatusCode::BAD_REQUEST,
                "{raw}"
            );
        }
    }

    #[actix_web::test]
    async fn startup_receipt_reports_only_the_configured_public_auth_authorities() {
        let address = "127.0.0.1:3100".parse().unwrap();
        let bearer_only = public_ingress_startup_receipt(address, None, false, false, false, false);
        assert_eq!(bearer_only["publicListener"], true);
        assert_eq!(
            bearer_only["nativeAuthentication"]["directRoutes"],
            serde_json::json!([
                "/api/orgs/:org_id/members/directory",
                "/api/orgs/:org_id/goals",
                "/api/orgs/:org_id/goals/workspace",
                "/api/orgs/:org_id/goals/assigned",
                "/api/orgs/:org_id/resources",
                "/api/orgs/:org_id/resources/:resource_id",
                "/api/orgs/:org_id/intelligence-profiles",
                "/api/orgs/:org_id/approvals",
                "/api/approvals/:approval_id",
                "/api/approvals/:approval_id/issues",
                "/api/issues/:issue_id/approvals",
                "/api/orgs/:org_id/labels"
            ])
        );
        assert!(bearer_only["nativeAuthentication"]["sessionCookieAuthority"].is_null());

        let managed_http = public_ingress_startup_receipt(address, None, true, true, false, false);
        assert_eq!(
            managed_http["nativeAuthentication"]["supportedCredentialStores"],
            serde_json::json!(["board_api_keys", "agent_api_keys", "agent_jwt"])
        );
        assert_eq!(
            managed_http["nativeAuthentication"]["localImplicitConstraint"],
            "numeric_loopback_listener_and_actual_peer"
        );

        let with_better_auth = public_ingress_startup_receipt(
            address,
            Some(NativeSessionAuthKind::BetterAuth),
            true,
            false,
            true,
            true,
        );
        assert_eq!(
            with_better_auth["nativeAuthentication"]["directRoutes"],
            serde_json::json!([
                "/api/orgs/:org_id/members/directory",
                "/api/orgs/:org_id/goals",
                "/api/orgs/:org_id/goals/workspace",
                "/api/orgs/:org_id/goals/assigned",
                "/api/orgs/:org_id/resources",
                "/api/orgs/:org_id/resources/:resource_id",
                "/api/orgs/:org_id/intelligence-profiles",
                "/api/orgs/:org_id/approvals",
                "/api/approvals/:approval_id",
                "/api/approvals/:approval_id/issues",
                "/api/issues/:issue_id/approvals",
                "/api/orgs/:org_id/labels",
                "/api/orgs/:org_id/agents",
                "/api/agents/:agent_id/permissions",
                "/api/orgs/:org_id/agent-configurations",
                "/api/orgs/:org_id/agents/name-suggestion",
                "/api/agents/:agent_id/configuration",
                "/api/agents/:agent_id/config-revisions",
                "/api/agents/:agent_id/config-revisions/:revision_id",
                "/api/agents/:agent_id/config-revisions/:revision_id/rollback",
                "/api/auth/get-session",
                "/api/auth/sign-up/email",
                "/api/auth/sign-in/email",
                "/api/auth/sign-out"
            ])
        );
        assert_eq!(
            with_better_auth["nativeAuthentication"]["sessionCookieAuthority"]["kind"],
            "better_auth"
        );
        assert_eq!(
            with_better_auth["nativeAuthentication"]["sessionCookieAuthority"]["unmigrated"],
            serde_json::json!([
                "remaining_auth_wildcard_routes",
                "websocket_session_resolution"
            ])
        );
        assert_eq!(
            with_better_auth["compatibilityAuthentication"]["nodeOwnedRoutes"],
            serde_json::json!([
                "remaining_auth_wildcard_routes",
                "websocket_session_resolution"
            ])
        );
        assert_eq!(
            with_better_auth["nativeEmailPasswordLifecycle"],
            serde_json::json!({
                "authority": "rust",
                "routes": ["POST /api/auth/sign-up/email", "POST /api/auth/sign-in/email", "POST /api/auth/sign-out"],
                "remainingAuthWildcard": "explicit-private-node-proxy",
            })
        );
        assert_eq!(
            with_better_auth["nativeCliBoardAuthentication"],
            serde_json::json!({
                "authority": "rust",
                "protocolVersion": 1,
                "routes": [
                    "POST /api/cli-auth/challenges",
                    "GET /api/cli-auth/challenges/:id",
                    "POST /api/cli-auth/challenges/:id/approve",
                    "POST /api/cli-auth/challenges/:id/cancel",
                    "GET /api/cli-auth/me",
                    "POST /api/cli-auth/revoke-current",
                ],
                "privateNodeFallback": false,
                "usesExistingBoardApiKeys": true,
            })
        );
        assert_eq!(
            with_better_auth["browserSessionAuthentication"],
            serde_json::json!({
                "enabled":true,"authority":"native-existing-session-cookie-resolver",
                "route":"GET /api/auth/get-session","nativeFailureFallback":false,
                "scope":"public_ingress_non_lifecycle_http_without_bearer",
            })
        );
        assert_eq!(
            bearer_only["browserSessionAuthentication"]["enabled"],
            false
        );
        let browser_only = public_ingress_startup_receipt(address, None, true, false, true, false);
        assert_eq!(
            browser_only["browserSessionAuthentication"]["authority"],
            "native-browser-session-resolver"
        );
        assert_eq!(
            browser_only["browserSessionAuthentication"]["enabled"],
            true
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
            for upgrade_values in [
                vec!["websocket"],
                vec!["h2c, WebSocket"],
                vec!["h2c", "websocket"],
            ] {
                let mut request = client
                    .get(format!("http://{address}{path}"))
                    .insert_header((header::CONNECTION, "Upgrade"))
                    .insert_header((header::SEC_WEBSOCKET_VERSION, "13"))
                    .insert_header((header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ=="));
                for upgrade_value in upgrade_values {
                    request = request.append_header((header::UPGRADE, upgrade_value));
                }
                let mut response = request.send().await.unwrap();
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
                let body: serde_json::Value = response.json().await.unwrap();
                assert_eq!(body["reason"], "route_not_found", "{path}");
            }
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

    fn database_url_with_application_name(database_url: &str, application_name: &str) -> String {
        let mut parsed = url::Url::parse(database_url).expect("test database URL must be valid");
        let existing = parsed
            .query_pairs()
            .filter(|(key, _)| key != "application_name")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        parsed.set_query(None);
        {
            let mut query = parsed.query_pairs_mut();
            for (key, value) in existing {
                query.append_pair(&key, &value);
            }
            query.append_pair("application_name", application_name);
        }
        parsed.to_string()
    }

    async fn wait_for_goal_read_relation_lock(pool: &PgPool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let blocked = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity AS activity JOIN pg_locks AS relation_lock ON relation_lock.pid = activity.pid JOIN pg_class AS relation ON relation.oid = relation_lock.relation WHERE activity.state = 'active' AND activity.wait_event_type = 'Lock' AND relation_lock.granted = false AND relation.relname = 'goals')",
            )
            .fetch_one(pool)
            .await
            .unwrap();
            if blocked {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "native goal read did not reach its goals query while the table lock was held"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[actix_web::test]
    async fn agent_detail_without_identity_never_reaches_compatibility_upstream() {
        let forwarded = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let node = HttpServer::new({
            let forwarded = forwarded.clone();
            move || {
                let forwarded = forwarded.clone();
                App::new().default_service(web::to(move || {
                    let forwarded = forwarded.clone();
                    async move {
                        forwarded.fetch_add(1, Ordering::SeqCst);
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
        let node_control = node.handle();
        let node_task = actix_web::rt::spawn(node);
        let foundation = Arc::new(
            AppState::new(ServerConfig {
                actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                workers: 1,
                ..ServerConfig::default()
            })
            .unwrap(),
        );
        // Only the programmatic constructor permits this defensive state;
        // the production CLI rejects missing identity configuration at boot.
        let config =
            PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL).unwrap();
        let runtime = PublicIngressRuntime::bind(config, foundation).unwrap();
        let address = runtime.bound_addr();
        let control = runtime.control();
        let task = actix_web::rt::spawn(runtime.run());
        let client = awc::Client::default();
        for path in [
            "/api/agents/agent-1",
            "/api/agents/me",
            "/API/AGENTS/agent-1/",
            "/API/AGENTS/ME/",
        ] {
            for method in [Method::GET, Method::HEAD] {
                let mut response = client
                    .request(method.clone(), format!("http://{address}{path}"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
                if method == Method::GET {
                    let body: serde_json::Value = response.json().await.unwrap();
                    assert_eq!(body["reason"], "native_identity_unavailable");
                } else {
                    assert!(response.body().await.unwrap().is_empty());
                }
            }
        }
        assert_eq!(forwarded.load(Ordering::SeqCst), 0);
        control.stop(true).await;
        task.await.unwrap().unwrap();
        node_control.stop(true).await;
        node_task.await.unwrap().unwrap();
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
    async fn native_goal_read_revalidates_and_reads_in_one_repeatable_read_transaction() {
        let pool = disposable_native_auth_pool().await;
        let suffix = Uuid::new_v4().simple().to_string();
        let org_id: String = sqlx::query_scalar(
            "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
        )
        .bind(format!("native-goal-read-{suffix}"))
        .bind(format!("Native goal read {suffix}"))
        .bind(format!("G{}", suffix[..7].to_ascii_uppercase()))
        .fetch_one(&pool)
        .await
        .unwrap();
        let user_id = format!("native-goal-read-user-{suffix}");
        sqlx::query(
            r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
               VALUES ($1, 'Native goal read user', $2, now(), now())"#,
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
        let agent_id: String = sqlx::query_scalar(
            "INSERT INTO agents (org_id, name, status) VALUES ($1::uuid, 'Native goal read agent', 'idle') RETURNING id::text",
        )
        .bind(&org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let token = format!("pcp_native_goal_read_{suffix}");
        let key_id: String = sqlx::query_scalar(
            "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'Native goal read key', $3) RETURNING id::text",
        )
        .bind(&agent_id)
        .bind(&org_id)
        .bind(native_bearer_auth::hash_token(&token))
        .fetch_one(&pool)
        .await
        .unwrap();
        let goal_id: String = sqlx::query_scalar(
            "INSERT INTO goals (org_id, title) VALUES ($1::uuid, 'Goal title before auth snapshot') RETURNING id::text",
        )
        .bind(&org_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        let application_name = format!("rudder-native-goal-read-{}", &suffix[..12]);
        let database_url = database_url_with_application_name(
            &env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap(),
            &application_name,
        );
        let foundation = Arc::new(
            AppState::new(ServerConfig {
                database_url: Some(database_url),
                actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
                workers: 1,
                ..ServerConfig::default()
            })
            .unwrap(),
        );
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE goals IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE goals SET title = 'Goal title changed after auth snapshot' WHERE id = $1::uuid",
        )
        .bind(&goal_id)
        .execute(&mut *blocker)
        .await
        .unwrap();

        let input = GoalReadRequest {
            view: GoalReadView::List,
            goal_id: None,
            cursor: None,
            limit: None,
            agent_id: None,
            lifecycle: None,
            focus: None,
            facet: None,
        };
        let actor = ActorIdentity::new("agent", &agent_id).unwrap();
        let token_hash = native_bearer_auth::hash_token(&token);
        let release_lock = tokio::spawn({
            let pool = pool.clone();
            async move {
                wait_for_goal_read_relation_lock(&pool).await;
                blocker.commit().await.unwrap();
            }
        });
        let response = foundation
            .goal_read_with_native_bearer(
                &org_id,
                &input,
                &actor,
                &format!("agent-key:{key_id}"),
                &token_hash,
            )
            .await;
        tokio::time::timeout(Duration::from_secs(5), release_lock)
            .await
            .expect("native goal read should reach its goals query")
            .unwrap();

        let status = response.status();
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK);
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let goal = payload
            .as_array()
            .unwrap()
            .iter()
            .find(|goal| goal["id"] == goal_id)
            .expect("seeded goal should be visible to the authorized agent");
        assert_eq!(goal["title"], "Goal title before auth snapshot");
        let current_title: String =
            sqlx::query_scalar("SELECT title FROM goals WHERE id = $1::uuid")
                .bind(&goal_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(current_title, "Goal title changed after auth snapshot");

        sqlx::query("DELETE FROM goals WHERE id = $1::uuid")
            .bind(&goal_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM agent_api_keys WHERE id = $1::uuid")
            .bind(&key_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM agents WHERE id = $1::uuid")
            .bind(&agent_id)
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
        .bind(format!("S{}", suffix[..7].to_ascii_uppercase()))
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
            local_account: None,
            cli_auth_browser_auth: None,
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
            local_account: None,
            cli_auth_browser_auth: None,
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
