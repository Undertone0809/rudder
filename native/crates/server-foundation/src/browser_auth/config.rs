use std::net::SocketAddr;

/// The two existing issuers intentionally have different renewal semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionPolicy {
    LocalAccount,
    BetterAuth,
}

#[derive(Clone)]
pub(super) enum Mode {
    Required {
        secret: Vec<u8>,
        secure_cookie: bool,
        session_policy: SessionPolicy,
    },
    LocalImplicit,
}

/// Immutable host configuration. No field is deserializable from a request.
/// Debug is deliberately omitted because this contains a session signing key.
#[derive(Clone)]
pub struct BrowserAuthConfig {
    pub(super) mode: Mode,
}

#[derive(Debug, thiserror::Error)]
pub enum BrowserAuthConfigError {
    #[error(
        "native browser session authentication requires an explicit secret of at least 32 bytes"
    )]
    InvalidSecret,
    #[error(
        "local implicit authentication requires optional auth, local_trusted mode, private exposure and a loopback listener"
    )]
    InvalidLocalTrust,
}

impl BrowserAuthConfig {
    pub fn required(
        secret: &[u8],
        secure_cookie: bool,
        session_policy: SessionPolicy,
    ) -> Result<Self, BrowserAuthConfigError> {
        if secret.len() < 32 {
            return Err(BrowserAuthConfigError::InvalidSecret);
        }
        Ok(Self {
            mode: Mode::Required {
                secret: secret.to_vec(),
                secure_cookie,
                session_policy,
            },
        })
    }

    pub fn local_implicit(
        listen: SocketAddr,
        deployment_mode: &str,
        exposure: &str,
        auth_requirement: &str,
    ) -> Result<Self, BrowserAuthConfigError> {
        if !listen.ip().is_loopback()
            || deployment_mode != "local_trusted"
            || exposure != "private"
            || auth_requirement != "optional"
        {
            return Err(BrowserAuthConfigError::InvalidLocalTrust);
        }
        Ok(Self {
            mode: Mode::LocalImplicit,
        })
    }

    pub(crate) fn from_env() -> Result<Option<Self>, crate::ConfigError> {
        Self::from_lookup(|name| match std::env::var(name) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => Err(crate::ConfigError::invalid(name, "must be valid Unicode")),
        })
    }

    pub(super) fn from_lookup(
        lookup: impl Fn(&str) -> Result<Option<String>, crate::ConfigError>,
    ) -> Result<Option<Self>, crate::ConfigError> {
        use crate::ConfigError;
        let mode = lookup("RUDDER_NATIVE_BROWSER_AUTH_MODE")?;
        let secret = lookup("RUDDER_NATIVE_BROWSER_AUTH_SECRET")?;
        let secure = lookup("RUDDER_NATIVE_BROWSER_AUTH_SECURE_COOKIE")?;
        let policy = lookup("RUDDER_NATIVE_BROWSER_AUTH_SESSION_POLICY")?;
        if let Some(issuer) = lookup("RUDDER_NATIVE_BROWSER_AUTH_ISSUER")? {
            if mode.is_some() || secret.is_some() || secure.is_some() || policy.is_some() {
                return Err(ConfigError::invalid(
                    "RUDDER_NATIVE_BROWSER_AUTH_ISSUER",
                    "issuer descriptor cannot be combined with standalone authentication overrides",
                ));
            }
            return super::issuer::parse(&issuer).map(Some);
        }
        let invalid = || {
            ConfigError::invalid(
                "RUDDER_NATIVE_BROWSER_AUTH_MODE",
                "explicit required mode, issuer secret and secure-cookie policy are required",
            )
        };
        let config = match mode.as_deref() {
            None if secret.is_none() && secure.is_none() && policy.is_none() => return Ok(None),
            Some("required") => {
                let secure = match secure.as_deref() {
                    Some("true") => true,
                    Some("false") => false,
                    _ => return Err(invalid()),
                };
                let policy = match policy.as_deref() {
                    Some("local_account") => SessionPolicy::LocalAccount,
                    Some("better_auth") => SessionPolicy::BetterAuth,
                    _ => return Err(invalid()),
                };
                Self::required(
                    secret.as_deref().ok_or_else(invalid)?.as_bytes(),
                    secure,
                    policy,
                )
            }
            // The process environment cannot prove the embedding's effective
            // local-account policy. Only a trusted embedding with the validated
            // startup facts may construct local implicit mode programmatically.
            _ => return Err(invalid()),
        }
        .map_err(|_| invalid())?;
        Ok(Some(config))
    }

    pub(crate) fn validate_listener(
        &self,
        listen: SocketAddr,
    ) -> Result<(), BrowserAuthConfigError> {
        if matches!(self.mode, Mode::LocalImplicit) && !listen.ip().is_loopback() {
            return Err(BrowserAuthConfigError::InvalidLocalTrust);
        }
        Ok(())
    }
}
