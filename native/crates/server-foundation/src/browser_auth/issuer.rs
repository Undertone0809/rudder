//! Startup-only issuer facts transported by the host. Never request data.
use super::{BrowserAuthConfig, SessionPolicy};
use serde::Deserialize;

// No Debug: this object contains the live issuer signing key.
#[derive(Deserialize)]
#[serde(tag = "issuer", deny_unknown_fields)]
enum Issuer {
    #[serde(rename = "local_account", rename_all = "camelCase")]
    LocalAccount { secret: String, secure_cookie: bool },
    #[serde(rename = "better_auth", rename_all = "camelCase")]
    BetterAuth {
        secret: String,
        secure_cookie: bool,
        session_cookie_name: String,
        dont_remember_cookie_name: String,
        expires_in: u64,
        update_age: u64,
        disable_session_refresh: bool,
        trusted_origins: Vec<String>,
        disable_sign_up: bool,
        rate_limit_enabled: bool,
    },
}

pub(super) fn parse(raw: &str) -> Result<BrowserAuthConfig, crate::ConfigError> {
    let invalid = || {
        crate::ConfigError::invalid(
            "RUDDER_NATIVE_BROWSER_AUTH_ISSUER",
            "unsupported or incomplete issuer configuration",
        )
    };
    // Do not expose serde errors: they may contain secret-bearing input.
    if raw.len() > 16384 {
        return Err(invalid());
    }
    let issuer: Issuer = serde_json::from_str(raw).map_err(|_| invalid())?;
    let (secret, secure, policy, email_config) = match issuer {
        Issuer::LocalAccount {
            secret,
            secure_cookie,
        } => (secret, secure_cookie, SessionPolicy::LocalAccount, None),
        Issuer::BetterAuth {
            secret,
            secure_cookie,
            session_cookie_name,
            dont_remember_cookie_name,
            expires_in,
            update_age,
            disable_session_refresh,
            trusted_origins,
            disable_sign_up,
            rate_limit_enabled,
        } => {
            let prefix = if secure_cookie { "__Secure-" } else { "" };
            if session_cookie_name != format!("{prefix}better-auth.session_token")
                || dont_remember_cookie_name != format!("{prefix}better-auth.dont_remember")
                || expires_in != 7 * 24 * 60 * 60
                || update_age != 24 * 60 * 60
                || disable_session_refresh
            {
                return Err(invalid());
            }
            (
                secret,
                secure_cookie,
                SessionPolicy::BetterAuth,
                Some(super::config::BetterAuthEmailConfig {
                    trusted_origins,
                    disable_sign_up,
                    rate_limit_enabled,
                }),
            )
        }
    };
    let mut config =
        BrowserAuthConfig::required(secret.as_bytes(), secure, policy).map_err(|_| invalid())?;
    config.better_auth_email = email_config;
    Ok(config)
}
