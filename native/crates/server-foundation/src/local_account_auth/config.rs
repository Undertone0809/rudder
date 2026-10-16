//! Startup configuration for native local-account lifecycle authority.
//!
//! Session signing material deliberately stays in `NativeSessionAuthConfig`.
//! This object contains only the issuer, installation, verifier-origin and
//! optional offline-grant policy selected by the runtime environment.

use super::{
    IdentityServerExchangeVerifier, LocalAccountAuthConfig, LocalAccountAuthError,
    LocalAccountAuthService, OfflineGrantConfig,
};
use crate::public_ingress_config::{NativeSessionAuthConfig, NativeSessionAuthKind};
use serde::Deserialize;
use sqlx::{Pool, Postgres};
use std::sync::Arc;
use url::Url;

/// The offline grant policy is a startup snapshot. Dynamic policy refresh is
/// not implemented yet and remains an explicit lifecycle integration debt.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeLocalAccountAuthConfig {
    installation_id: String,
    expected_issuer: String,
    audience: String,
    identity_origin: String,
    #[serde(default)]
    offline: Option<NativeOfflineGrantConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeOfflineGrantConfig {
    identity_key_id: String,
    identity_public_key_spki: String,
    expected_account_id: String,
    expected_device_id: String,
    last_trusted_time_ms: u64,
    local_sign_out_epoch: u64,
    #[serde(default)]
    expected_auth_schema_epoch: Option<u64>,
    #[serde(default)]
    expected_account_auth_epoch: Option<u64>,
    #[serde(default)]
    expected_device_auth_epoch: Option<u64>,
}

impl NativeLocalAccountAuthConfig {
    pub(crate) fn parse(raw: &str) -> Result<Self, &'static str> {
        let config: Self = serde_json::from_str(raw)
            .map_err(|_| "expected strict camelCase local-account lifecycle JSON")?;
        config.validate()?;
        Ok(config)
    }

    pub(crate) fn validate_session(
        &self,
        session: Option<&NativeSessionAuthConfig>,
    ) -> Result<(), &'static str> {
        match session.map(|session| session.kind) {
            Some(NativeSessionAuthKind::LocalAccount) => Ok(()),
            Some(NativeSessionAuthKind::BetterAuth) => {
                Err("requires local_account session authentication")
            }
            None => Err("requires configured local_account session authentication"),
        }
    }

    /// Constructs the service using the already-validated native session
    /// secret and cookie policy. No second session secret is accepted here.
    pub(crate) fn build_service(
        &self,
        pool: Pool<Postgres>,
        session: &NativeSessionAuthConfig,
    ) -> Result<LocalAccountAuthService, LocalAccountAuthError> {
        if session.kind != NativeSessionAuthKind::LocalAccount {
            return Err(LocalAccountAuthError::InvalidConfiguration);
        }
        let verifier = Arc::new(IdentityServerExchangeVerifier::new(
            &self.identity_origin,
            self.audience.clone(),
            self.installation_id.clone(),
        )?);
        LocalAccountAuthService::new(
            pool,
            LocalAccountAuthConfig {
                installation_id: self.installation_id.clone(),
                expected_issuer: self.expected_issuer.clone(),
                audience: self.audience.clone(),
                session_secret: session.secret.clone(),
                secure_cookie: session.secure_cookie,
                offline: self
                    .offline
                    .as_ref()
                    .map(NativeOfflineGrantConfig::into_policy),
            },
            verifier,
        )
    }

    fn validate(&self) -> Result<(), &'static str> {
        if self.installation_id.trim().is_empty() || self.installation_id.len() > 512 {
            return Err("installationId must be non-empty and at most 512 bytes");
        }
        if self.expected_issuer.trim().is_empty() || self.expected_issuer.len() > 512 {
            return Err("expectedIssuer must be non-empty and at most 512 bytes");
        }
        if self.audience.trim().is_empty() || self.audience.len() > 512 {
            return Err("audience must be non-empty and at most 512 bytes");
        }
        if self.identity_origin.trim().is_empty() || self.identity_origin.len() > 2048 {
            return Err("identityOrigin must be non-empty and at most 2048 bytes");
        }

        // Run the production verifier's origin validation during startup config
        // parsing so malformed or unsafe origins cannot fail later at request
        // time. This builds a local HTTP client but makes no network request.
        IdentityServerExchangeVerifier::new(
            &self.identity_origin,
            self.audience.clone(),
            self.installation_id.clone(),
        )
        .map_err(|_| "identityOrigin, audience or installationId is invalid")?;
        let origin = Url::parse(&self.identity_origin)
            .map_err(|_| "identityOrigin must be a valid HTTPS or loopback HTTP origin")?;
        let origin = origin.origin().ascii_serialization();
        if super::normalize_issuer(&self.expected_issuer) != origin {
            return Err("expectedIssuer must match the identityOrigin origin");
        }

        if self.offline.as_ref().is_some_and(|offline| {
            super::offline_grant::validate_policy(&offline.as_policy()).is_err()
        }) {
            return Err("offline policy is invalid");
        }
        Ok(())
    }
}

impl NativeOfflineGrantConfig {
    fn as_policy(&self) -> OfflineGrantConfig {
        OfflineGrantConfig {
            identity_key_id: self.identity_key_id.clone(),
            identity_public_key_spki: self.identity_public_key_spki.clone(),
            expected_account_id: self.expected_account_id.clone(),
            expected_device_id: self.expected_device_id.clone(),
            last_trusted_time_ms: self.last_trusted_time_ms,
            local_sign_out_epoch: self.local_sign_out_epoch,
            expected_auth_schema_epoch: self.expected_auth_schema_epoch,
            expected_account_auth_epoch: self.expected_account_auth_epoch,
            expected_device_auth_epoch: self.expected_device_auth_epoch,
        }
    }

    fn into_policy(&self) -> OfflineGrantConfig {
        self.as_policy()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::public_ingress_config::NativeSessionAuthConfig;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    const VALID: &str = r#"{
      "installationId":"desktop-installation",
      "expectedIssuer":"https://identity.example",
      "audience":"rudder-desktop",
      "identityOrigin":"https://identity.example"
    }"#;
    const ASSERTION_KEY: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn parses_strict_camel_case_lifecycle_settings() {
        let config = NativeLocalAccountAuthConfig::parse(VALID).unwrap();
        let session = NativeSessionAuthConfig::new(
            NativeSessionAuthKind::LocalAccount,
            "existing native session secret",
            true,
            ASSERTION_KEY,
        )
        .unwrap();

        assert!(config.validate_session(Some(&session)).is_ok());
    }

    #[test]
    fn rejects_unknown_fields_malformed_json_and_mismatched_issuer_origin() {
        assert!(NativeLocalAccountAuthConfig::parse("").is_err());
        assert!(NativeLocalAccountAuthConfig::parse(
            r#"{"installationId":"x","expectedIssuer":"https://identity.example","audience":"a","identityOrigin":"https://identity.example","sessionSecret":"must-not-be-accepted"}"#
        )
        .is_err());
        assert!(
            NativeLocalAccountAuthConfig::parse(&VALID.replace(
                "\"expectedIssuer\":\"https://identity.example\"",
                "\"expectedIssuer\":\"https://wrong.example\"",
            ))
            .is_err()
        );
    }

    #[test]
    fn rejects_unsafe_identity_origins_and_non_local_session_modes() {
        let unsafe_origin = VALID.replace("https://identity.example", "http://identity.example");
        assert!(NativeLocalAccountAuthConfig::parse(&unsafe_origin).is_err());

        let config = NativeLocalAccountAuthConfig::parse(VALID).unwrap();
        let better_auth = NativeSessionAuthConfig::new(
            NativeSessionAuthKind::BetterAuth,
            "existing native session secret",
            true,
            ASSERTION_KEY,
        )
        .unwrap();
        assert!(config.validate_session(Some(&better_auth)).is_err());
        assert!(config.validate_session(None).is_err());
    }

    #[test]
    fn parses_and_validates_the_optional_offline_policy_shape() {
        let mut spki = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        spki.extend_from_slice(&[0; 32]);
        let value: serde_json::Value = serde_json::from_str(VALID).unwrap();
        let mut value = value;
        value.as_object_mut().unwrap().insert(
            "offline".to_owned(),
            serde_json::json!({
                "identityKeyId": "identity-key-1",
                "identityPublicKeySpki": URL_SAFE_NO_PAD.encode(spki),
                "expectedAccountId": "account-1",
                "expectedDeviceId": "device-1",
                "lastTrustedTimeMs": 1_000_000,
                "localSignOutEpoch": 3,
                "expectedAuthSchemaEpoch": 4
            }),
        );

        let config = NativeLocalAccountAuthConfig::parse(&value.to_string()).unwrap();
        let policy = config.offline.unwrap().as_policy();
        assert_eq!(policy.expected_account_id, "account-1");
        assert_eq!(policy.expected_device_id, "device-1");
        assert_eq!(policy.local_sign_out_epoch, 3);
        assert_eq!(policy.expected_auth_schema_epoch, Some(4));
        assert_eq!(policy.expected_account_auth_epoch, None);
        assert_eq!(policy.expected_device_auth_epoch, None);
    }
}
