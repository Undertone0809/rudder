//! Explicit listener topology for the next public-ingress authority slice.
//! This configuration does not enable a cutover by itself.

use std::net::SocketAddr;
use thiserror::Error;

#[derive(Clone)]
pub struct PublicIngressConfig {
    pub listen_addr: SocketAddr,
    pub(crate) node_upstream: String,
    pub(crate) authorization_key: String,
    pub(crate) forwarding_policy: crate::public_ingress_forwarding::ForwardingPolicy,
    pub(crate) session_auth: Option<NativeSessionAuthConfig>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeSessionAuthKind {
    BetterAuth,
    LocalAccount,
}

#[derive(Clone)]
pub(crate) struct NativeSessionAuthConfig {
    pub(crate) kind: NativeSessionAuthKind,
    pub(crate) secret: String,
    pub(crate) secure_cookie: bool,
    pub(crate) assertion_key: String,
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
        match (listen, upstream, key) {
            (None, None, None) => {
                if session_mode.is_some()
                    || session_kind.is_some()
                    || session_secret.is_some()
                    || session_cookie_secure.is_some()
                    || session_assertion_key.is_some()
                {
                    return Err(crate::ConfigError::invalid(
                        "RUDDER_NATIVE_SESSION_AUTH_MODE",
                        "session auth requires public ingress to be configured",
                    ));
                }
                Ok(None)
            }
            (Some(listen), Some(upstream), Some(key)) => {
                let listen = listen.parse().map_err(|_| {
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
                Self::new(listen, &upstream, &key)
                    .map(|mut config| {
                        config.forwarding_policy = policy;
                        config.session_auth = session_auth;
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
            node_upstream: format!("http://{socket}"),
            authorization_key: authorization_key.to_owned(),
            forwarding_policy: Default::default(),
            session_auth: None,
        })
    }

    pub fn node_upstream(&self) -> &str {
        &self.node_upstream
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
