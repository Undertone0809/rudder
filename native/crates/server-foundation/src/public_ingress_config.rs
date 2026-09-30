//! Explicit listener topology for the next public-ingress authority slice.
//! This configuration does not enable a cutover by itself.

use std::net::SocketAddr;
use thiserror::Error;

#[derive(Clone)]
pub struct PublicIngressConfig {
    pub listen_addr: SocketAddr,
    pub(crate) node_upstream: String,
    pub(crate) authorization_key: String,
}

#[derive(Debug, Error)]
pub enum PublicIngressConfigError {
    #[error("public ingress requires a fixed HTTP loopback upstream with an explicit port")]
    InvalidUpstream,
    #[error("public ingress and private upstream must use distinct sockets")]
    OverlappingListener,
    #[error("public ingress authorization key must contain at least 32 bytes and no whitespace")]
    InvalidAuthorizationKey,
}

impl PublicIngressConfig {
    pub fn from_env() -> Result<Option<Self>, crate::ConfigError> {
        let listen = crate::optional_env("RUDDER_NATIVE_PUBLIC_LISTEN")?;
        let upstream = crate::optional_env("RUDDER_NATIVE_NODE_UPSTREAM")?;
        let key = crate::optional_env("RUDDER_NATIVE_INGRESS_AUTH_KEY")?;
        match (listen, upstream, key) {
            (None, None, None) => Ok(None),
            (Some(listen), Some(upstream), Some(key)) => {
                let listen = listen.parse().map_err(|_| {
                    crate::ConfigError::invalid(
                        "RUDDER_NATIVE_PUBLIC_LISTEN",
                        "numeric socket address required",
                    )
                })?;
                Self::new(listen, &upstream, &key)
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
        })
    }

    pub fn node_upstream(&self) -> &str {
        &self.node_upstream
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "0123456789abcdef0123456789abcdef";

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
