//! Explicit listener topology for the next public-ingress authority slice.
//! This configuration does not enable a cutover by itself.

use rudder_d1_persistence::native_chat::config::LocalHostContext;
use rudder_native_chat_executor::HostPaths;
use std::{net::SocketAddr, time::Duration};
use thiserror::Error;

use crate::local_account_auth::{
    LocalAccountAuthError, LocalAccountAuthService, NativeLocalAccountAuthConfig,
};
use crate::native_agent_jwt::NativeAgentJwtConfig;

#[derive(Clone)]
pub struct PublicIngressConfig {
    pub listen_addr: SocketAddr,
    pub(crate) deployment_mode: String,
    pub(crate) node_upstream: String,
    pub(crate) authorization_key: String,
    pub(crate) forwarding_policy: crate::public_ingress_forwarding::ForwardingPolicy,
    pub(crate) session_auth: Option<NativeSessionAuthConfig>,
    pub(crate) browser_auth: Option<crate::browser_auth::BrowserAuthConfig>,
    pub(crate) native_chat_mutations: Option<crate::browser_auth::BrowserMutationPolicy>,
    pub(crate) native_chat_runtime: Option<NativeChatPublicRuntime>,
    pub(crate) local_account_auth: Option<NativeLocalAccountAuthConfig>,
    pub(crate) identity_auth: Option<NativeIdentityAuthConfig>,
    pub(crate) websocket_cookie_fallback: NativeWebSocketCookieFallback,
    pub(crate) private_host_gate: Option<crate::private_host_gate::NativePrivateHostGate>,
}

/// Trusted installation context required by the explicitly enabled public
/// Native Chat send route. It is constructed by Rust startup code.
#[derive(Clone)]
pub struct NativeChatPublicRuntime {
    pub(crate) host: LocalHostContext,
    pub(crate) paths: HostPaths,
    pub(crate) timeout: Duration,
}

impl NativeChatPublicRuntime {
    pub fn new(
        host: LocalHostContext,
        paths: HostPaths,
        timeout: Duration,
    ) -> Result<Self, PublicIngressConfigError> {
        if timeout.is_zero() || timeout > Duration::from_secs(3600) {
            return Err(PublicIngressConfigError::InvalidNativeChatRuntime);
        }
        Ok(Self { host, paths, timeout })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeSessionAuthKind {
    BetterAuth,
    LocalAccount,
}

/// Describes which identity the existing private Node WebSocket authorizer
/// selects when no bearer or non-empty query token is present.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeWebSocketCookieFallback {
    SessionCookie,
    LocalTrustedImplicit,
}

#[derive(Clone)]
pub(crate) struct NativeSessionAuthConfig {
    pub(crate) kind: NativeSessionAuthKind,
    pub(crate) secret: String,
    pub(crate) secure_cookie: bool,
    pub(crate) assertion_key: String,
}

#[derive(Clone)]
pub(crate) struct NativeIdentityAuthConfig {
    pub(crate) assertion_key: String,
    pub(crate) agent_jwt: NativeAgentJwtConfig,
    pub(crate) local_implicit_enabled: bool,
}

impl NativeIdentityAuthConfig {
    pub(crate) fn new(
        assertion_key: &str,
        agent_jwt_secret: &str,
        agent_jwt_issuer: &str,
        agent_jwt_audience: &str,
        local_implicit_enabled: bool,
    ) -> Result<Self, PublicIngressConfigError> {
        validate_key(assertion_key)
            .map_err(|_| PublicIngressConfigError::InvalidIdentityAssertionKey)?;
        if assertion_key == agent_jwt_secret {
            return Err(PublicIngressConfigError::AssertionKeyReusedForCredentialSigning);
        }
        Ok(Self {
            assertion_key: assertion_key.to_owned(),
            agent_jwt: NativeAgentJwtConfig {
                secret: agent_jwt_secret.to_owned(),
                issuer: agent_jwt_issuer.to_owned(),
                audience: agent_jwt_audience.to_owned(),
            },
            local_implicit_enabled,
        })
    }
}

impl NativeSessionAuthConfig {
    pub(crate) fn new(
        kind: NativeSessionAuthKind,
        secret: &str,
        secure_cookie: bool,
        assertion_key: &str,
    ) -> Result<Self, PublicIngressConfigError> {
        if secret.trim().is_empty() {
            return Err(PublicIngressConfigError::InvalidSessionSecret);
        }
        validate_key(assertion_key)
            .map_err(|_| PublicIngressConfigError::InvalidSessionAssertionKey)?;
        if assertion_key == secret {
            return Err(PublicIngressConfigError::AssertionKeyReusedForCredentialSigning);
        }
        Ok(Self {
            kind,
            secret: secret.to_owned(),
            secure_cookie,
            assertion_key: assertion_key.to_owned(),
        })
    }

    pub(crate) fn session_cookie_name(&self) -> &'static str {
        match (self.kind, self.secure_cookie) {
            (NativeSessionAuthKind::BetterAuth, false)
            | (NativeSessionAuthKind::LocalAccount, false) => "better-auth.session_token",
            (NativeSessionAuthKind::BetterAuth, true)
            | (NativeSessionAuthKind::LocalAccount, true) => "__Secure-better-auth.session_token",
        }
    }

    pub(crate) fn dont_remember_cookie_name(&self) -> &'static str {
        if self.secure_cookie {
            "__Secure-better-auth.dont_remember"
        } else {
            "better-auth.dont_remember"
        }
    }
}

#[derive(Debug, Error)]
pub enum PublicIngressConfigError {
    #[error("public ingress requires a fixed HTTP loopback upstream with an explicit port")]
    InvalidUpstream,
    #[error("public ingress and private upstream must use distinct sockets")]
    OverlappingListener,
    #[error("public ingress authorization key must contain at least 32 bytes and no whitespace")]
    InvalidAuthorizationKey,
    #[error("native session secret must not be empty")]
    InvalidSessionSecret,
    #[error("native session assertion key must contain at least 32 bytes and no whitespace")]
    InvalidSessionAssertionKey,
    #[error("native identity assertion key must contain at least 32 bytes and no whitespace")]
    InvalidIdentityAssertionKey,
    #[error("native local implicit authentication requires a numeric loopback listener")]
    LocalImplicitRequiresLoopback,
    #[error("native session and identity assertion keys must be identical")]
    AssertionKeyMismatch,
    #[error("native transport assertion key must differ from credential signing secrets")]
    AssertionKeyReusedForCredentialSigning,
    #[error("Native Chat public runtime timeout must be between 1 and 3600 seconds")]
    InvalidNativeChatRuntime,
}

impl PublicIngressConfig {
    pub fn from_env() -> Result<Option<Self>, crate::ConfigError> {
        let listen = crate::optional_env("RUDDER_NATIVE_PUBLIC_LISTEN")?;
        let upstream = crate::optional_env("RUDDER_NATIVE_NODE_UPSTREAM")?;
        let key = crate::optional_env("RUDDER_NATIVE_INGRESS_AUTH_KEY")?;
        let session_mode = crate::optional_env("RUDDER_NATIVE_SESSION_AUTH_MODE")?;
        let session_kind = crate::optional_env("RUDDER_NATIVE_SESSION_AUTH_KIND")?;
        let session_secret = crate::optional_env("RUDDER_NATIVE_SESSION_AUTH_SECRET")?;
        let session_cookie_secure = crate::optional_env("RUDDER_NATIVE_SESSION_COOKIE_SECURE")?;
        let session_assertion_key = crate::optional_env("RUDDER_NATIVE_SESSION_ASSERTION_KEY")?;
        let identity_auth_mode = crate::optional_env("RUDDER_NATIVE_IDENTITY_AUTH_MODE")?;
        let identity_assertion_key = crate::optional_env("RUDDER_NATIVE_IDENTITY_ASSERTION_KEY")?;
        let local_implicit = crate::optional_env("RUDDER_NATIVE_LOCAL_IMPLICIT")?;
        let local_account_auth_raw =
            crate::optional_env("RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG")?;
        let websocket_cookie_fallback =
            crate::optional_env("RUDDER_NATIVE_WEBSOCKET_COOKIE_FALLBACK")?;
        let deployment_mode = crate::optional_env("RUDDER_NATIVE_DEPLOYMENT_MODE")?
            .unwrap_or_else(|| "authenticated".to_owned());
        if !matches!(deployment_mode.as_str(), "local_trusted" | "authenticated") {
            return Err(crate::ConfigError::invalid(
                "RUDDER_NATIVE_DEPLOYMENT_MODE",
                "expected local_trusted or authenticated",
            ));
        }
        let private_host_gate_raw = crate::optional_env("RUDDER_NATIVE_PRIVATE_HOST_GATE")?;
        match (listen, upstream, key) {
            (None, None, None) => {
                if local_account_auth_raw.is_some() {
                    return Err(crate::ConfigError::invalid(
                        "RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG",
                        "requires public ingress to be configured",
                    ));
                }
                if session_mode.is_some()
                    || session_kind.is_some()
                    || session_secret.is_some()
                    || session_cookie_secure.is_some()
                    || session_assertion_key.is_some()
                    || identity_auth_mode.is_some()
                    || identity_assertion_key.is_some()
                    || local_implicit.is_some()
                    || websocket_cookie_fallback.is_some()
                    || private_host_gate_raw.is_some()
                    || std::env::var_os("RUDDER_NATIVE_AGENT_JWT_SECRET").is_some()
                    || std::env::var_os("RUDDER_NATIVE_AGENT_JWT_ISSUER").is_some()
                    || std::env::var_os("RUDDER_NATIVE_AGENT_JWT_AUDIENCE").is_some()
                {
                    return Err(crate::ConfigError::invalid(
                        "RUDDER_NATIVE_SESSION_AUTH_MODE",
                        "session auth requires public ingress to be configured",
                    ));
                }
                Ok(None)
            }
            (Some(listen), Some(upstream), Some(key)) => {
                let listen: SocketAddr = listen.parse().map_err(|_| {
                    crate::ConfigError::invalid(
                        "RUDDER_NATIVE_PUBLIC_LISTEN",
                        "numeric socket address required",
                    )
                })?;
                let trusted = crate::optional_env("RUDDER_NATIVE_INGRESS_TRUSTED_PROXIES")?
                    .unwrap_or_default();
                let policy = crate::public_ingress_forwarding::ForwardingPolicy::parse(&trusted)
                    .map_err(|message| {
                        crate::ConfigError::invalid(
                            "RUDDER_NATIVE_INGRESS_TRUSTED_PROXIES",
                            message,
                        )
                    })?;
                let private_host_gate = private_host_gate_raw
                    .as_deref()
                    .map(crate::private_host_gate::NativePrivateHostGate::parse)
                    .transpose()
                    .map_err(|message| {
                        crate::ConfigError::invalid("RUDDER_NATIVE_PRIVATE_HOST_GATE", message)
                    })?;
                let session_auth = match (
                    session_mode.as_deref(),
                    session_kind.as_deref(),
                    session_secret.as_deref(),
                    session_cookie_secure.as_deref(),
                    session_assertion_key.as_deref(),
                ) {
                    (None, None, None, None, None) => None,
                    (
                        Some("required"),
                        Some(kind),
                        Some(secret),
                        Some(secure),
                        Some(assertion_key),
                    ) => {
                        let kind = match kind {
                            "better_auth" => NativeSessionAuthKind::BetterAuth,
                            "local_account" => NativeSessionAuthKind::LocalAccount,
                            _ => {
                                return Err(crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_SESSION_AUTH_KIND",
                                    "expected better_auth or local_account",
                                ));
                            }
                        };
                        let secure_cookie = match secure {
                            "true" => true,
                            "false" => false,
                            _ => {
                                return Err(crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_SESSION_COOKIE_SECURE",
                                    "expected true or false",
                                ));
                            }
                        };
                        Some(
                            NativeSessionAuthConfig::new(
                                kind,
                                secret,
                                secure_cookie,
                                assertion_key,
                            )
                            .map_err(|_| {
                                crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_SESSION_AUTH_MODE",
                                    "invalid required session auth configuration",
                                )
                            })?,
                        )
                    }
                    _ => {
                        return Err(crate::ConfigError::invalid(
                            "RUDDER_NATIVE_SESSION_AUTH_MODE",
                            "required mode, kind, session secret, cookie policy and assertion key must be configured together",
                        ));
                    }
                };
                let local_account_auth = local_account_auth_raw
                    .as_deref()
                    .map(NativeLocalAccountAuthConfig::parse)
                    .transpose()
                    .map_err(|message| {
                        crate::ConfigError::invalid(
                            "RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG",
                            message,
                        )
                    })?;
                if let Some(local_account_auth) = local_account_auth.as_ref() {
                    local_account_auth
                        .validate_session(session_auth.as_ref())
                        .map_err(|message| {
                            crate::ConfigError::invalid(
                                "RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG",
                                message,
                            )
                        })?;
                }
                let websocket_cookie_fallback = parse_websocket_cookie_fallback(
                    session_auth.as_ref(),
                    websocket_cookie_fallback.as_deref(),
                )
                .map_err(|message| {
                    crate::ConfigError::invalid("RUDDER_NATIVE_WEBSOCKET_COOKIE_FALLBACK", message)
                })?;
                let identity_auth = match (
                    identity_auth_mode.as_deref(),
                    identity_assertion_key.as_deref(),
                    local_implicit.as_deref(),
                ) {
                    (None, None, None) => {
                        return Err(crate::ConfigError::invalid(
                            "RUDDER_NATIVE_IDENTITY_AUTH_MODE",
                            "required mode, assertion key and local implicit policy must be configured together",
                        ));
                    }
                    (Some("required"), Some(assertion_key), Some(local_implicit)) => {
                        let local_implicit_enabled = match local_implicit {
                            "true" => true,
                            "false" => false,
                            _ => {
                                return Err(crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_LOCAL_IMPLICIT",
                                    "expected true or false",
                                ));
                            }
                        };
                        let agent_jwt_secret = std::env::var("RUDDER_NATIVE_AGENT_JWT_SECRET")
                            .map_err(|_| {
                                crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_AGENT_JWT_SECRET",
                                    "required when native identity auth is enabled",
                                )
                            })?;
                        let agent_jwt_issuer = std::env::var("RUDDER_NATIVE_AGENT_JWT_ISSUER")
                            .map_err(|_| {
                                crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_AGENT_JWT_ISSUER",
                                    "required when native identity auth is enabled",
                                )
                            })?;
                        let agent_jwt_audience = std::env::var("RUDDER_NATIVE_AGENT_JWT_AUDIENCE")
                            .map_err(|_| {
                                crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_AGENT_JWT_AUDIENCE",
                                    "required when native identity auth is enabled",
                                )
                            })?;
                        Some(
                            NativeIdentityAuthConfig::new(
                                assertion_key,
                                &agent_jwt_secret,
                                &agent_jwt_issuer,
                                &agent_jwt_audience,
                                local_implicit_enabled,
                            )
                            .map_err(|_| {
                                crate::ConfigError::invalid(
                                    "RUDDER_NATIVE_IDENTITY_AUTH_MODE",
                                    "invalid required identity auth configuration",
                                )
                            })?,
                        )
                    }
                    _ => {
                        return Err(crate::ConfigError::invalid(
                            "RUDDER_NATIVE_IDENTITY_AUTH_MODE",
                            "required mode, assertion key and local implicit policy must be configured together",
                        ));
                    }
                };
                if let (Some(identity), Some(session)) =
                    (identity_auth.as_ref(), session_auth.as_ref())
                    && identity.assertion_key != session.assertion_key
                {
                    return Err(crate::ConfigError::invalid(
                        "RUDDER_NATIVE_IDENTITY_ASSERTION_KEY",
                        "must match RUDDER_NATIVE_SESSION_ASSERTION_KEY",
                    ));
                }
                if identity_auth
                    .as_ref()
                    .is_some_and(|identity| identity.local_implicit_enabled)
                    && !listen.ip().is_loopback()
                {
                    return Err(crate::ConfigError::invalid(
                        "RUDDER_NATIVE_LOCAL_IMPLICIT",
                        "local implicit authentication requires a loopback listener",
                    ));
                }
                let browser_auth = crate::browser_auth::BrowserAuthConfig::from_env()?;
                Self::new(listen, &upstream, &key)
                    .map(|mut config| {
                        config.deployment_mode = deployment_mode;
                        config.forwarding_policy = policy;
                        config.session_auth = session_auth;
                        config.local_account_auth = local_account_auth;
                        config.identity_auth = identity_auth;
                        config.websocket_cookie_fallback = websocket_cookie_fallback;
                        config.private_host_gate = private_host_gate;
                        config.browser_auth = browser_auth;
                        config
                    })
                    .map(Some)
                    .map_err(|error| {
                        crate::ConfigError::invalid(
                            "RUDDER_NATIVE_PUBLIC_INGRESS",
                            &error.to_string(),
                        )
                    })
            }
            _ => Err(crate::ConfigError::invalid(
                "RUDDER_NATIVE_PUBLIC_INGRESS",
                "listen, fixed upstream and authorization key must all be configured",
            )),
        }
    }

    pub fn new(
        listen_addr: SocketAddr,
        node_upstream: &str,
        authorization_key: &str,
    ) -> Result<Self, PublicIngressConfigError> {
        // A socket address deliberately excludes DNS resolution, userinfo,
        // query strings, path prefixes and redirect-derived destinations.
        let raw_socket = node_upstream
            .strip_prefix("http://")
            .ok_or(PublicIngressConfigError::InvalidUpstream)?;
        let socket = raw_socket
            .parse::<SocketAddr>()
            .map_err(|_| PublicIngressConfigError::InvalidUpstream)?;
        if !socket.ip().is_loopback() || socket.port() == 0 {
            return Err(PublicIngressConfigError::InvalidUpstream);
        }
        // An unspecified public address includes the private loopback socket.
        // A port-zero public listener is assigned by the OS and cannot conflict.
        if listen_addr.port() != 0
            && listen_addr.port() == socket.port()
            && (listen_addr.ip() == socket.ip() || listen_addr.ip().is_unspecified())
        {
            return Err(PublicIngressConfigError::OverlappingListener);
        }
        if authorization_key.len() < 32
            || authorization_key
                .bytes()
                .any(|byte| !(0x21..=0x7e).contains(&byte))
        {
            return Err(PublicIngressConfigError::InvalidAuthorizationKey);
        }
        Ok(Self {
            listen_addr,
            deployment_mode: "authenticated".to_owned(),
            node_upstream: format!("http://{socket}"),
            authorization_key: authorization_key.to_owned(),
            forwarding_policy: Default::default(),
            session_auth: None,
            browser_auth: None,
            native_chat_mutations: None,
            native_chat_runtime: None,
            local_account_auth: None,
            identity_auth: None,
            websocket_cookie_fallback: NativeWebSocketCookieFallback::SessionCookie,
            private_host_gate: None,
        })
    }

    pub fn node_upstream(&self) -> &str {
        &self.node_upstream
    }

    pub fn with_browser_auth(
        mut self,
        config: crate::browser_auth::BrowserAuthConfig,
    ) -> Result<Self, crate::browser_auth::BrowserAuthConfigError> {
        config.validate_listener(self.listen_addr)?;
        self.browser_auth = Some(config);
        Ok(self)
    }

    pub fn with_native_chat_mutation_policy(
        mut self,
        policy: crate::browser_auth::BrowserMutationPolicy,
    ) -> Self {
        self.native_chat_mutations = Some(policy);
        self
    }

    pub fn with_native_chat_runtime(mut self, runtime: NativeChatPublicRuntime) -> Self {
        self.native_chat_runtime = Some(runtime);
        self
    }

    pub fn browser_session_authentication_enabled(&self) -> bool {
        self.browser_auth.is_some() || self.session_auth.is_some()
    }

    pub(crate) fn build_local_account_auth_service(
        &self,
        pool: sqlx::Pool<sqlx::Postgres>,
    ) -> Result<Option<LocalAccountAuthService>, LocalAccountAuthError> {
        let Some(local_account_auth) = self.local_account_auth.as_ref() else {
            return Ok(None);
        };
        let Some(session_auth) = self.session_auth.as_ref() else {
            return Err(LocalAccountAuthError::InvalidConfiguration);
        };
        local_account_auth
            .build_service(pool, session_auth)
            .map(Some)
    }
}

fn parse_websocket_cookie_fallback(
    session_auth: Option<&NativeSessionAuthConfig>,
    configured: Option<&str>,
) -> Result<NativeWebSocketCookieFallback, &'static str> {
    match (session_auth.map(|settings| settings.kind), configured) {
        (Some(NativeSessionAuthKind::LocalAccount), Some("session")) => {
            Ok(NativeWebSocketCookieFallback::SessionCookie)
        }
        (Some(NativeSessionAuthKind::LocalAccount), Some("local_implicit")) => {
            Ok(NativeWebSocketCookieFallback::LocalTrustedImplicit)
        }
        (Some(NativeSessionAuthKind::LocalAccount), None) => Err(
            "must explicitly be session or local_implicit when local-account session auth is enabled",
        ),
        (Some(NativeSessionAuthKind::LocalAccount), Some(_)) => {
            Err("expected session or local_implicit")
        }
        (Some(NativeSessionAuthKind::BetterAuth) | None, None) => {
            Ok(NativeWebSocketCookieFallback::SessionCookie)
        }
        (Some(NativeSessionAuthKind::BetterAuth) | None, Some(_)) => {
            Err("only applies to local-account session auth")
        }
    }
}

fn validate_key(key: &str) -> Result<(), ()> {
    if key.len() < 32 || key.bytes().any(|byte| !(0x21..=0x7e).contains(&byte)) {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn websocket_cookie_fallback_requires_an_explicit_local_account_selection() {
        let local_account = NativeSessionAuthConfig::new(
            NativeSessionAuthKind::LocalAccount,
            "valid local secret",
            false,
            KEY,
        )
        .unwrap();
        let better_auth = NativeSessionAuthConfig::new(
            NativeSessionAuthKind::BetterAuth,
            "valid better auth secret",
            false,
            KEY,
        )
        .unwrap();

        assert_eq!(
            parse_websocket_cookie_fallback(Some(&local_account), Some("session")),
            Ok(NativeWebSocketCookieFallback::SessionCookie)
        );
        assert_eq!(
            parse_websocket_cookie_fallback(Some(&local_account), Some("local_implicit")),
            Ok(NativeWebSocketCookieFallback::LocalTrustedImplicit)
        );
        assert!(parse_websocket_cookie_fallback(Some(&local_account), None).is_err());
        assert!(parse_websocket_cookie_fallback(Some(&local_account), Some("optional")).is_err());
        assert!(parse_websocket_cookie_fallback(Some(&better_auth), Some("session")).is_err());
    }

    #[test]
    fn native_session_auth_rejects_missing_or_weak_secrets() {
        for secret in ["", "   "] {
            assert!(NativeSessionAuthConfig::new(
                NativeSessionAuthKind::BetterAuth,
                secret,
                false,
                KEY,
            )
            .is_err());
        }
        assert!(
            NativeSessionAuthConfig::new(
                NativeSessionAuthKind::LocalAccount,
                "valid local secret",
                false,
                "short",
            )
            .is_err()
        );
    }

    #[test]
    fn transport_assertion_key_is_separate_from_cookie_and_agent_jwt_secrets() {
        let cookie_secret = "distinct-cookie-session-signing-secret";
        let agent_jwt_secret = "distinct-agent-jwt-signing-secret";
        let rejected_cookie_secrets = [
            NativeSessionAuthKind::BetterAuth,
            NativeSessionAuthKind::LocalAccount,
        ]
        .into_iter()
        .map(|kind| NativeSessionAuthConfig::new(kind, KEY, false, KEY));
        for result in rejected_cookie_secrets {
            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("cookie and transport keys must not be reused"),
            };
            assert!(matches!(
                &error,
                PublicIngressConfigError::AssertionKeyReusedForCredentialSigning
            ));
            assert!(!error.to_string().contains(KEY));
        }

        let error = match NativeIdentityAuthConfig::new(KEY, KEY, "rudder", "rudder-api", false) {
            Err(error) => error,
            Ok(_) => panic!("Agent JWT and transport keys must not be reused"),
        };
        assert!(matches!(
            &error,
            PublicIngressConfigError::AssertionKeyReusedForCredentialSigning
        ));
        assert!(!error.to_string().contains(KEY));

        let session = NativeSessionAuthConfig::new(
            NativeSessionAuthKind::LocalAccount,
            cookie_secret,
            false,
            KEY,
        )
        .expect("cookie signing key may be separate from the transport key");
        let identity =
            NativeIdentityAuthConfig::new(KEY, agent_jwt_secret, "rudder", "rudder-api", false)
                .expect("Agent JWT signing key may be separate from the transport key");
        assert_eq!(session.assertion_key, identity.assertion_key);
    }

    #[test]
    fn public_ingress_rejects_open_proxy_and_overlapping_listener_topologies() {
        let public = "0.0.0.0:3100".parse().unwrap();
        for target in [
            "http://localhost:3101",
            "http://example.com:3101",
            "http://192.0.2.1:3101",
            "https://127.0.0.1:3101",
            "http://127.0.0.1:0",
            "http://127.0.0.1:3101/",
            "http://user@127.0.0.1:3101",
            "http://127.0.0.1:3101?target=remote",
            "http://127.0.0.1:3100",
        ] {
            assert!(
                PublicIngressConfig::new(public, target, KEY).is_err(),
                "{target}"
            );
        }
        assert!(PublicIngressConfig::new(public, "http://127.0.0.1:3101", KEY).is_ok());
        assert!(PublicIngressConfig::new(public, "http://[::1]:3101", KEY).is_ok());
    }

    #[test]
    fn public_ingress_rejects_weak_or_header_invalid_authorization_keys() {
        let public = "127.0.0.1:0".parse().unwrap();
        for key in [
            "",
            "short",
            "0123456789abcdef0123456789abcdef\r\n",
            "0123456789abcdef0123456789abcdeé",
        ] {
            assert!(PublicIngressConfig::new(public, "http://127.0.0.1:3101", key).is_err());
        }
    }
}
