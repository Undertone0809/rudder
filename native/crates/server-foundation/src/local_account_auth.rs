//! Rust-owned local Rudder account lifecycle state transitions.
//!
//! The hosted exchange verifier remains an explicit network dependency. The
//! verifier below calls the configured Rudder Identity origin directly and
//! returns typed credential, availability, and response failures. No Node
//! service participates in redemption, session issuance, claim, or revocation.

pub(crate) mod config;
mod offline_grant;
mod operator_state;
pub(crate) use config::NativeLocalAccountAuthConfig;
pub use offline_grant::OfflineGrantProofPayload;

use crate::NativeSessionRevocationRegistry;
use crate::native_session_auth::sign_session_token;
use reqwest::{Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Pool, Postgres, Row, Transaction};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use time::{OffsetDateTime, format_description};
use url::Url;
use uuid::Uuid;

const LOCAL_BOARD_USER_ID: &str = "local-board";
const LOCAL_SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const IDENTITY_EXCHANGE_PATH: &str = "/api/server/exchange/verify";

pub type ServerExchangeFuture<'a> = Pin<
    Box<dyn Future<Output = Result<VerifiedServerExchange, ExchangeVerifierError>> + Send + 'a>,
>;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalServerExchangeRequest {
    pub exchange_code: String,
}

/// A verified account exchange assertion returned by the configured identity
/// service. `email_verified` is only true when the pinned Identity response was
/// successful and its contract promises a verified email address.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedServerExchange {
    pub issuer: String,
    pub subject: String,
    pub audience: String,
    pub installation_id: String,
    pub jti: String,
    pub expires_at_ms: i64,
    pub email: String,
    pub email_verified: bool,
    #[serde(default)]
    pub name: Option<String>,
}

/// Errors from the hosted exchange dependency stay distinguishable so an
/// offline grant can be considered only after an availability failure, never
/// after a rejected credential or malformed Identity response.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ExchangeVerifierError {
    #[error("Rudder Identity is unavailable")]
    Unavailable,
    #[error("Rudder Identity rejected the exchange code")]
    Rejected,
    #[error("Rudder Identity returned an invalid exchange response")]
    InvalidResponse,
}

/// Trust boundary for hosted exchange verification. Production construction
/// uses [`IdentityServerExchangeVerifier`]; tests may inject verified claims.
pub trait ServerExchangeVerifier: Send + Sync {
    fn verify<'a>(&'a self, exchange_code: &'a str) -> ServerExchangeFuture<'a>;
}

/// Direct, source-configured client for Rudder Identity's exchange verifier.
/// The request cannot choose or redirect the verifier origin.
pub struct IdentityServerExchangeVerifier {
    client: Client,
    endpoint: Url,
    expected_audience: String,
    expected_installation_id: String,
}

#[derive(Serialize)]
struct IdentityExchangeRequest<'a> {
    code: &'a str,
    expected_audience: &'a str,
    expected_installation_id: &'a str,
}

impl IdentityServerExchangeVerifier {
    pub fn new(
        identity_origin: &str,
        expected_audience: impl Into<String>,
        expected_installation_id: impl Into<String>,
    ) -> Result<Self, LocalAccountAuthError> {
        let mut origin =
            Url::parse(identity_origin).map_err(|_| LocalAccountAuthError::InvalidConfiguration)?;
        if !origin.username().is_empty() || origin.password().is_some() {
            return Err(LocalAccountAuthError::InvalidConfiguration);
        }
        let loopback_http = origin.scheme() == "http"
            && matches!(
                origin.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            );
        if origin.scheme() != "https" && !loopback_http {
            return Err(LocalAccountAuthError::InvalidConfiguration);
        }
        if origin.host_str().is_none() {
            return Err(LocalAccountAuthError::InvalidConfiguration);
        }
        origin.set_path(IDENTITY_EXCHANGE_PATH);
        origin.set_query(None);
        origin.set_fragment(None);
        let expected_audience = expected_audience.into();
        let expected_installation_id = expected_installation_id.into();
        if expected_audience.trim().is_empty()
            || expected_audience.len() > 512
            || expected_installation_id.trim().is_empty()
            || expected_installation_id.len() > 512
        {
            return Err(LocalAccountAuthError::InvalidConfiguration);
        }
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(Policy::none())
                .build()
                .map_err(|_| LocalAccountAuthError::InvalidConfiguration)?,
            endpoint: origin,
            expected_audience,
            expected_installation_id,
        })
    }
}

impl ServerExchangeVerifier for IdentityServerExchangeVerifier {
    fn verify<'a>(&'a self, exchange_code: &'a str) -> ServerExchangeFuture<'a> {
        Box::pin(async move {
            if exchange_code.len() < 16 || exchange_code.len() > 16_384 {
                return Err(ExchangeVerifierError::Rejected);
            }
            let request = IdentityExchangeRequest {
                code: exchange_code,
                expected_audience: &self.expected_audience,
                expected_installation_id: &self.expected_installation_id,
            };
            let mut response = self
                .client
                .post(self.endpoint.as_str())
                .json(&request)
                .send()
                .await
                .map_err(|_| ExchangeVerifierError::Unavailable)?;
            let status = response.status();
            if status.is_server_error() || matches!(status.as_u16(), 408 | 425 | 429) {
                return Err(ExchangeVerifierError::Unavailable);
            }
            if status.is_client_error() {
                return Err(ExchangeVerifierError::Rejected);
            }
            if !status.is_success() {
                return Err(ExchangeVerifierError::InvalidResponse);
            }
            const MAX_IDENTITY_RESPONSE_BYTES: usize = 64 * 1024;
            if response
                .content_length()
                .is_some_and(|length| length > MAX_IDENTITY_RESPONSE_BYTES as u64)
            {
                return Err(ExchangeVerifierError::InvalidResponse);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ExchangeVerifierError::Unavailable)?
            {
                if body.len().saturating_add(chunk.len()) > MAX_IDENTITY_RESPONSE_BYTES {
                    return Err(ExchangeVerifierError::InvalidResponse);
                }
                body.extend_from_slice(&chunk);
            }
            let value = serde_json::from_slice::<Value>(&body)
                .map_err(|_| ExchangeVerifierError::InvalidResponse)?;
            parse_identity_exchange(value).ok_or(ExchangeVerifierError::InvalidResponse)
        })
    }
}

fn parse_identity_exchange(value: Value) -> Option<VerifiedServerExchange> {
    let record = value.as_object()?;
    let required = |key: &str, max: usize| -> Option<String> {
        let value = record.get(key)?.as_str()?;
        if value.trim().is_empty() || value.len() > max {
            return None;
        }
        Some(value.to_owned())
    };
    let expires_at = required("expiresAt", 64)?;
    let expires_at_ms =
        OffsetDateTime::parse(&expires_at, &time::format_description::well_known::Rfc3339)
            .ok()?
            .unix_timestamp_nanos()
            .checked_div(1_000_000)?;
    let email = required("email", 320)?.trim().to_ascii_lowercase();
    if !email.contains('@') {
        return None;
    }
    Some(VerifiedServerExchange {
        issuer: required("issuer", 512)?,
        subject: required("subject", 512)?,
        audience: required("audience", 512)?,
        installation_id: required("installationId", 512)?,
        jti: required("jti", 512)?,
        expires_at_ms: i64::try_from(expires_at_ms).ok()?,
        email,
        email_verified: true,
        name: record
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| name.len() <= 512)
            .map(str::to_owned),
    })
}

/// Inputs accepted only from the selected local runtime configuration.
#[derive(Clone)]
pub struct LocalAccountAuthConfig {
    pub installation_id: String,
    pub expected_issuer: String,
    pub audience: String,
    pub session_secret: String,
    pub secure_cookie: bool,
    pub offline: Option<OfflineGrantConfig>,
}

#[derive(Clone)]
pub struct OfflineGrantConfig {
    pub identity_key_id: String,
    pub identity_public_key_spki: String,
    pub expected_account_id: String,
    pub expected_device_id: String,
    pub last_trusted_time_ms: u64,
    pub local_sign_out_epoch: u64,
    pub expected_auth_schema_epoch: Option<u64>,
    pub expected_account_auth_epoch: Option<u64>,
    pub expected_device_auth_epoch: Option<u64>,
}

#[derive(Clone)]
pub struct LocalAccountAuthService {
    pool: Pool<Postgres>,
    config: Arc<LocalAccountAuthConfig>,
    verifier: Arc<dyn ServerExchangeVerifier>,
    last_trusted_time_ms: Arc<AtomicU64>,
}

#[derive(Debug, Error)]
pub enum LocalAccountAuthError {
    #[error("invalid local account configuration")]
    InvalidConfiguration,
    #[error("the account credential was rejected")]
    InvalidCredential,
    #[error("the account operation conflicts with existing state")]
    Conflict,
    #[error("{0}")]
    Forbidden(LocalAccountForbiddenReason),
    #[error("the identity verifier is unavailable")]
    Unavailable,
    #[error("the identity verifier response is invalid")]
    InvalidVerifierResponse,
    #[error("local account database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("local account session signing failed")]
    SessionSigning,
    #[error("local account time value is out of range")]
    InvalidTime,
    #[error("local account revocation task failed")]
    RevocationTask,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum LocalAccountForbiddenReason {
    #[error("Offline Grant account is not bound to this Local Workspace")]
    OfflineAccountNotBoundToWorkspace,
    #[error("Offline Grant does not match the claimed Local Workspace")]
    OfflineGrantDoesNotMatchClaimedWorkspace,
    #[error("The current local user is not bound to a Rudder Account")]
    CurrentLocalUserNotBoundToRudderAccount,
    #[error("This Rudder installation is already claimed by another account")]
    InstallationAlreadyClaimedByAnotherAccount,
}

#[derive(Clone, Debug)]
pub struct LocalSessionIssue {
    pub id: String,
    pub user_id: String,
    pub expires_at: String,
    pub set_cookie: String,
}

#[derive(Clone, Debug)]
pub struct LocalAccountExchangeResult {
    pub user_id: String,
    pub session: LocalSessionIssue,
}

#[derive(Clone, Debug)]
pub struct LocalAccountOfflineResult {
    pub user_id: String,
    pub next_trusted_time_ms: u64,
    pub session: LocalSessionIssue,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccountClaimResult {
    pub status: &'static str,
    pub local_user_id: String,
    pub org_ids: Vec<String>,
}

/// Post-commit revocation effect for the ingress/websocket owner to publish.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionRevoked {
    pub user_id: String,
    pub revoked_session_count: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalOfflineGrantProof {
    pub payload: OfflineGrantProofPayload,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalOfflineGrantRequest {
    pub grant: String,
    pub proof: LocalOfflineGrantProof,
    pub device_public_key_spki: String,
}

impl LocalAccountAuthService {
    pub fn new(
        pool: Pool<Postgres>,
        config: LocalAccountAuthConfig,
        verifier: Arc<dyn ServerExchangeVerifier>,
    ) -> Result<Self, LocalAccountAuthError> {
        let expected_issuer = normalize_issuer(&config.expected_issuer);
        if expected_issuer.is_empty()
            || expected_issuer.len() > 512
            || config.installation_id.trim().is_empty()
            || config.installation_id.len() > 512
            || config.audience.trim().is_empty()
            || config.audience.len() > 512
            || config.session_secret.trim().is_empty()
            || config
                .offline
                .as_ref()
                .is_some_and(|offline| offline_grant::validate_policy(offline).is_err())
        {
            return Err(LocalAccountAuthError::InvalidConfiguration);
        }
        let config = LocalAccountAuthConfig {
            expected_issuer,
            ..config
        };
        let trusted_time = config
            .offline
            .as_ref()
            .map(|offline| offline.last_trusted_time_ms)
            .unwrap_or_default();
        Ok(Self {
            pool,
            config: Arc::new(config),
            verifier,
            last_trusted_time_ms: Arc::new(AtomicU64::new(trusted_time)),
        })
    }

    /// Verify the hosted exchange code and atomically redeem its issuer/JTI,
    /// bind the external subject, and issue the Better Auth session.
    pub async fn redeem_exchange(
        &self,
        exchange_code: &str,
    ) -> Result<LocalAccountExchangeResult, LocalAccountAuthError> {
        if exchange_code.len() < 16 || exchange_code.len() > 16_384 {
            return Err(LocalAccountAuthError::InvalidCredential);
        }
        let claims = self
            .verifier
            .verify(exchange_code)
            .await
            .map_err(|error| match error {
                ExchangeVerifierError::Unavailable => LocalAccountAuthError::Unavailable,
                ExchangeVerifierError::Rejected => LocalAccountAuthError::InvalidCredential,
                ExchangeVerifierError::InvalidResponse => {
                    LocalAccountAuthError::InvalidVerifierResponse
                }
            })?;
        self.redeem_verified_exchange(claims).await
    }

    async fn redeem_verified_exchange(
        &self,
        claims: VerifiedServerExchange,
    ) -> Result<LocalAccountExchangeResult, LocalAccountAuthError> {
        let now_ms = unix_time_millis()?;
        let issuer = normalize_issuer(&claims.issuer);
        if issuer != self.config.expected_issuer
            || claims.audience != self.config.audience
            || claims.installation_id != self.config.installation_id
            || claims.expires_at_ms <= now_ms
            || issuer.len() > 512
            || claims.subject.len() > 512
            || claims.audience.len() > 512
            || claims.installation_id.len() > 512
            || claims.jti.trim().is_empty()
            || claims.jti.len() > 512
            || claims.subject.trim().is_empty()
            || !claims.email_verified
            || claims.email.trim().is_empty()
            || claims.email.len() > 320
            || !claims.email.contains('@')
        {
            return Err(LocalAccountAuthError::InvalidCredential);
        }

        let mut transaction = self.pool.begin().await?;
        let redemption_id: Option<String> = sqlx::query_scalar(
            r#"
            INSERT INTO server_exchange_redemptions
              (issuer, jti, audience, subject, expires_at)
            VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0))
            ON CONFLICT (issuer, jti) DO NOTHING
            RETURNING id::text
            "#,
        )
        .bind(&issuer)
        .bind(&claims.jti)
        .bind(&claims.audience)
        .bind(&claims.subject)
        .bind(claims.expires_at_ms)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(redemption_id) = redemption_id else {
            return Err(LocalAccountAuthError::Conflict);
        };

        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))")
            .bind(&issuer)
            .bind(&claims.subject)
            .execute(&mut *transaction)
            .await?;
        let local_user_id: Option<String> = sqlx::query_scalar(
            r#"
            SELECT local_user_id
            FROM external_user_bindings
            WHERE issuer = $1 AND subject = $2
            FOR UPDATE
            "#,
        )
        .bind(&issuer)
        .bind(&claims.subject)
        .fetch_optional(&mut *transaction)
        .await?;

        let user_id = match local_user_id {
            Some(user_id) => {
                sqlx::query(
                    "UPDATE external_user_bindings SET last_verified_at = to_timestamp($3::double precision / 1000.0) WHERE issuer = $1 AND subject = $2",
                )
                .bind(&issuer)
                .bind(&claims.subject)
                .bind(now_ms)
                .execute(&mut *transaction)
                .await?;
                user_id
            }
            None => {
                let user_id = Uuid::new_v4().to_string();
                let name = claims
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(claims.email.as_str());
                sqlx::query(
                    r#"
                    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
                    VALUES ($1, $2, $3, TRUE,
                      to_timestamp($4::double precision / 1000.0),
                      to_timestamp($4::double precision / 1000.0))
                    "#,
                )
                .bind(&user_id)
                .bind(name)
                .bind(claims.email.trim().to_ascii_lowercase())
                .bind(now_ms)
                .execute(&mut *transaction)
                .await?;
                sqlx::query(
                    r#"
                    INSERT INTO external_user_bindings
                      (issuer, subject, local_user_id, created_at, last_verified_at)
                    VALUES ($1, $2, $3,
                      to_timestamp($4::double precision / 1000.0),
                      to_timestamp($4::double precision / 1000.0))
                    "#,
                )
                .bind(&issuer)
                .bind(&claims.subject)
                .bind(&user_id)
                .bind(now_ms)
                .execute(&mut *transaction)
                .await?;
                user_id
            }
        };

        let session = self
            .insert_session(&mut transaction, &user_id, now_ms, None)
            .await?;
        sqlx::query(
            "UPDATE server_exchange_redemptions SET local_user_id = $2 WHERE id::text = $1",
        )
        .bind(redemption_id)
        .bind(&user_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(LocalAccountExchangeResult { user_id, session })
    }

    /// Validate the signed Offline Grant and device proof before consuming the
    /// nonce in PostgreSQL. Binding, replay receipt, and new session commit as
    /// one transaction so failed bindings do not consume legitimate proofs.
    pub async fn redeem_offline(
        &self,
        input: LocalOfflineGrantRequest,
    ) -> Result<LocalAccountOfflineResult, LocalAccountAuthError> {
        if !(32..=32_768).contains(&input.grant.len())
            || !(32..=4_096).contains(&input.device_public_key_spki.len())
            || !(16..=1_024).contains(&input.proof.signature.len())
            || !(16..=128).contains(&input.proof.payload.grant_hash.len())
            || !(1..=16).contains(&input.proof.payload.method.len())
            || !(1..=2_048).contains(&input.proof.payload.path.len())
            || !(1..=128).contains(&input.proof.payload.body_hash.len())
        {
            return Err(LocalAccountAuthError::InvalidCredential);
        }
        let offline = self
            .config
            .offline
            .as_ref()
            .ok_or(LocalAccountAuthError::InvalidCredential)?;
        let now_ms = unix_time_millis()?;
        let last_trusted_time_ms = self.last_trusted_time_ms.load(Ordering::Acquire);
        let verified = offline_grant::verify_grant_and_proof(
            offline,
            offline_grant::OfflineGrantTarget {
                issuer: &self.config.expected_issuer,
                installation_id: &self.config.installation_id,
            },
            &input.grant,
            &input.device_public_key_spki,
            &input.proof,
            now_ms,
            last_trusted_time_ms,
        )
        .map_err(|_| LocalAccountAuthError::InvalidCredential)?;

        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "DELETE FROM server_exchange_redemptions WHERE expires_at < to_timestamp($1::double precision / 1000.0)",
        )
        .bind(now_ms)
        .execute(&mut *transaction)
        .await?;
        let nonce_hash = offline_grant::sha256_base64url(input.proof.payload.nonce.as_bytes());
        let replay_jti = format!("offline:{}:{nonce_hash}", verified.jti);
        let redemption_id: Option<String> = sqlx::query_scalar(
            r#"
            INSERT INTO server_exchange_redemptions
              (issuer, jti, audience, subject, expires_at)
            VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0))
            ON CONFLICT (issuer, jti) DO NOTHING
            RETURNING id::text
            "#,
        )
        .bind(normalize_issuer(&verified.issuer))
        .bind(replay_jti)
        .bind(&verified.audience)
        .bind(&verified.account_id)
        .bind(verified.expires_at_ms)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(redemption_id) = redemption_id else {
            return Err(LocalAccountAuthError::Conflict);
        };
        let binding: Option<String> = sqlx::query_scalar(
            r#"
            SELECT local_user_id FROM external_user_bindings
            WHERE issuer = $1 AND subject = $2
            FOR UPDATE
            "#,
        )
        .bind(normalize_issuer(&verified.issuer))
        .bind(&verified.account_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(user_id) = binding else {
            return Err(LocalAccountAuthError::Forbidden(
                LocalAccountForbiddenReason::OfflineAccountNotBoundToWorkspace,
            ));
        };
        let installation_binding: Option<String> = sqlx::query_scalar(
            r#"
            SELECT local_user_id FROM installation_account_bindings
            WHERE installation_id = $1 AND issuer = $2 AND subject = $3
              AND local_user_id = $4
            FOR UPDATE
            "#,
        )
        .bind(&self.config.installation_id)
        .bind(normalize_issuer(&verified.issuer))
        .bind(&verified.account_id)
        .bind(&user_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if installation_binding.is_none() {
            return Err(LocalAccountAuthError::Forbidden(
                LocalAccountForbiddenReason::OfflineGrantDoesNotMatchClaimedWorkspace,
            ));
        }
        let session = self
            .insert_session(
                &mut transaction,
                &user_id,
                now_ms,
                Some(verified.expires_at_ms),
            )
            .await?;
        sqlx::query(
            "UPDATE server_exchange_redemptions SET local_user_id = $2 WHERE id::text = $1",
        )
        .bind(redemption_id)
        .bind(&user_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;

        self.last_trusted_time_ms
            .fetch_max(verified.next_trusted_time_ms, Ordering::AcqRel);
        Ok(LocalAccountOfflineResult {
            user_id,
            next_trusted_time_ms: verified.next_trusted_time_ms,
            session,
        })
    }

    /// Claim the current `local-board` installation for the authenticated
    /// account. The installation lock makes first claim and repeated claims
    /// atomic with membership/admin transfer and operator-state reconciliation.
    pub async fn claim_legacy_installation(
        &self,
        local_user_id: &str,
    ) -> Result<LocalAccountClaimResult, LocalAccountAuthError> {
        if local_user_id.trim().is_empty() {
            return Err(LocalAccountAuthError::Forbidden(
                LocalAccountForbiddenReason::CurrentLocalUserNotBoundToRudderAccount,
            ));
        }
        let issuer = &self.config.expected_issuer;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(&self.config.installation_id)
            .execute(&mut *transaction)
            .await?;

        let existing = sqlx::query(
            r#"
            SELECT issuer, subject, local_user_id
            FROM installation_account_bindings
            WHERE installation_id = $1
            FOR UPDATE
            "#,
        )
        .bind(&self.config.installation_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(existing) = existing {
            let existing_issuer: String = existing.try_get("issuer")?;
            let existing_subject: String = existing.try_get("subject")?;
            let existing_user_id: String = existing.try_get("local_user_id")?;
            let (is_bound_to_current_user, has_any_current_binding): (bool, bool) = sqlx::query_as(
                r#"
                SELECT
                  EXISTS (
                    SELECT 1 FROM external_user_bindings
                    WHERE issuer = $1 AND subject = $2 AND local_user_id = $3
                  ),
                  EXISTS (
                    SELECT 1 FROM external_user_bindings
                    WHERE issuer = $1 AND local_user_id = $3
                  )
                "#,
            )
            .bind(issuer)
            .bind(&existing_subject)
            .bind(local_user_id)
            .fetch_one(&mut *transaction)
            .await?;
            if !has_any_current_binding {
                return Err(LocalAccountAuthError::Forbidden(
                    LocalAccountForbiddenReason::CurrentLocalUserNotBoundToRudderAccount,
                ));
            }
            if normalize_issuer(&existing_issuer).as_str() != issuer.as_str()
                || existing_user_id != local_user_id
                || !is_bound_to_current_user
            {
                return Err(LocalAccountAuthError::Forbidden(
                    LocalAccountForbiddenReason::InstallationAlreadyClaimedByAnotherAccount,
                ));
            }
            let copied = operator_state::copy_legacy_operator_state(
                &mut transaction,
                &self.config.installation_id,
                local_user_id,
            )
            .await?;
            transaction.commit().await?;
            return Ok(LocalAccountClaimResult {
                status: "already_claimed",
                local_user_id: existing_user_id,
                org_ids: copied.org_ids,
            });
        }

        let binding = sqlx::query(
            r#"
            SELECT subject FROM external_user_bindings
            WHERE issuer = $1 AND local_user_id = $2
            ORDER BY subject
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(issuer)
        .bind(local_user_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(binding) = binding else {
            return Err(LocalAccountAuthError::Forbidden(
                LocalAccountForbiddenReason::CurrentLocalUserNotBoundToRudderAccount,
            ));
        };
        let subject: String = binding.try_get("subject")?;
        sqlx::query(
            r#"
            INSERT INTO installation_account_bindings
              (installation_id, issuer, subject, local_user_id)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(&self.config.installation_id)
        .bind(issuer)
        .bind(&subject)
        .bind(local_user_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO instance_user_roles (user_id, role)
            VALUES ($1, 'instance_admin')
            ON CONFLICT (user_id, role) DO NOTHING
            "#,
        )
        .bind(local_user_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM instance_user_roles WHERE user_id = $1 AND role = 'instance_admin'",
        )
        .bind(LOCAL_BOARD_USER_ID)
        .execute(&mut *transaction)
        .await?;

        let legacy_memberships = sqlx::query(
            r#"
            SELECT id::text, org_id::text, membership_role
            FROM organization_memberships
            WHERE principal_type = 'user' AND principal_id = $1 AND status = 'active'
            ORDER BY org_id, id
            FOR UPDATE
            "#,
        )
        .bind(LOCAL_BOARD_USER_ID)
        .fetch_all(&mut *transaction)
        .await?;
        let mut org_ids = Vec::with_capacity(legacy_memberships.len());
        for membership in legacy_memberships {
            let membership_id: String = membership.try_get("id")?;
            let org_id: String = membership.try_get("org_id")?;
            let membership_role: Option<String> = membership.try_get("membership_role")?;
            sqlx::query(
                r#"
                INSERT INTO organization_memberships
                  (org_id, principal_type, principal_id, status, membership_role)
                VALUES ($1::uuid, 'user', $2, 'active', $3)
                ON CONFLICT (org_id, principal_type, principal_id)
                DO UPDATE SET status = 'active', membership_role = EXCLUDED.membership_role,
                  updated_at = clock_timestamp()
                "#,
            )
            .bind(&org_id)
            .bind(local_user_id)
            .bind(membership_role)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE organization_memberships SET status = 'revoked', updated_at = clock_timestamp() WHERE id::text = $1",
            )
            .bind(membership_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                r#"
                INSERT INTO activity_log
                  (org_id, actor_type, actor_id, action, entity_type, entity_id, details)
                VALUES ($1::uuid, 'user', $2, 'installation.legacy_local_claimed',
                  'installation', $3, jsonb_build_object('priorPrincipalId', $4, 'issuer', $5))
                "#,
            )
            .bind(&org_id)
            .bind(local_user_id)
            .bind(&self.config.installation_id)
            .bind(LOCAL_BOARD_USER_ID)
            .bind(issuer)
            .execute(&mut *transaction)
            .await?;
            org_ids.push(org_id);
        }
        operator_state::copy_legacy_operator_state(
            &mut transaction,
            &self.config.installation_id,
            local_user_id,
        )
        .await?;
        transaction.commit().await?;
        Ok(LocalAccountClaimResult {
            status: "claimed",
            local_user_id: local_user_id.to_owned(),
            org_ids,
        })
    }

    /// Delete every account session and append one audit row per active
    /// organization membership. The caller publishes the returned revocation
    /// effect to the websocket owner only after this method commits.
    pub async fn revoke_all_sessions(
        &self,
        local_user_id: &str,
    ) -> Result<LocalSessionRevoked, LocalAccountAuthError> {
        if local_user_id.trim().is_empty() {
            return Err(LocalAccountAuthError::Forbidden(
                LocalAccountForbiddenReason::CurrentLocalUserNotBoundToRudderAccount,
            ));
        }
        let mut transaction = self.pool.begin().await?;
        let revoked_session_count =
            sqlx::query("DELETE FROM session WHERE user_id = $1 RETURNING id")
                .bind(local_user_id)
                .fetch_all(&mut *transaction)
                .await?
                .len() as u64;
        sqlx::query(
            r#"
            INSERT INTO activity_log
              (org_id, actor_type, actor_id, action, entity_type, entity_id, details)
            SELECT org_id, 'user', $1, 'account.local_sessions_revoked', 'user', $1,
              jsonb_build_object('revokedSessionCount', $2::bigint)
            FROM organization_memberships
            WHERE principal_type = 'user' AND principal_id = $1 AND status = 'active'
            "#,
        )
        .bind(local_user_id)
        .bind(revoked_session_count as i64)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(LocalSessionRevoked {
            user_id: local_user_id.to_owned(),
            revoked_session_count,
        })
    }

    /// Own the database revocation and websocket notification as one Tokio
    /// task. Awaiting this method returns the durable result, while dropping
    /// the HTTP request future after dispatch does not cancel the task between
    /// commit and publication.
    pub async fn revoke_all_sessions_owned(
        &self,
        local_user_id: String,
        registry: NativeSessionRevocationRegistry,
    ) -> Result<LocalSessionRevoked, LocalAccountAuthError> {
        let service = self.clone();
        tokio::spawn(async move {
            let result = service.revoke_all_sessions(&local_user_id).await?;
            registry.publish_user_revocation(&result.user_id);
            Ok::<_, LocalAccountAuthError>(result)
        })
        .await
        .map_err(|_| LocalAccountAuthError::RevocationTask)?
    }

    async fn insert_session(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        user_id: &str,
        now_ms: i64,
        cap_expires_at_ms: Option<i64>,
    ) -> Result<LocalSessionIssue, LocalAccountAuthError> {
        let session_id = Uuid::new_v4().to_string();
        let token = offline_grant::random_session_token()
            .map_err(|_| LocalAccountAuthError::SessionSigning)?;
        let default_expiry = now_ms
            .checked_add(LOCAL_SESSION_TTL_MS)
            .ok_or(LocalAccountAuthError::InvalidTime)?;
        let expires_at_ms = cap_expires_at_ms.map_or(default_expiry, |cap| cap.min(default_expiry));
        if expires_at_ms <= now_ms {
            return Err(LocalAccountAuthError::InvalidCredential);
        }
        sqlx::query(
            r#"
            INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
            VALUES ($1, $2, $3,
              to_timestamp($4::double precision / 1000.0),
              to_timestamp($5::double precision / 1000.0),
              to_timestamp($5::double precision / 1000.0))
            "#,
        )
        .bind(&session_id)
        .bind(&token)
        .bind(user_id)
        .bind(expires_at_ms)
        .bind(now_ms)
        .execute(&mut **transaction)
        .await?;
        let signed = sign_session_token(&token, &self.config.session_secret)
            .map_err(|_| LocalAccountAuthError::SessionSigning)?;
        let expires_at =
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(expires_at_ms) * 1_000_000)
                .map_err(|_| LocalAccountAuthError::InvalidTime)?;
        let set_cookie = local_session_cookie(&signed, expires_at, self.config.secure_cookie)?;
        Ok(LocalSessionIssue {
            id: session_id,
            user_id: user_id.to_owned(),
            expires_at: expires_at
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| LocalAccountAuthError::InvalidTime)?,
            set_cookie,
        })
    }
}

fn local_session_cookie(
    signed_token: &str,
    expires_at: OffsetDateTime,
    secure: bool,
) -> Result<String, LocalAccountAuthError> {
    let name = if secure {
        "__Secure-better-auth.session_token"
    } else {
        "better-auth.session_token"
    };
    let description = format_description::parse_borrowed::<2>(
        "[weekday repr:short], [day padding:zero] [month repr:short] [year] [hour padding:zero]:[minute padding:zero]:[second padding:zero] GMT",
    )
    .map_err(|_| LocalAccountAuthError::InvalidTime)?;
    let expires = expires_at
        .format(&description)
        .map_err(|_| LocalAccountAuthError::InvalidTime)?;
    let mut value = format!(
        "{name}={}; Path=/; HttpOnly; SameSite=Lax; Expires={expires}",
        encode_cookie_component(signed_token)
    );
    if secure {
        value.push_str("; Secure");
    }
    Ok(value)
}

fn encode_cookie_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn normalize_issuer(issuer: &str) -> String {
    issuer.trim().trim_end_matches('/').to_owned()
}

fn unix_time_millis() -> Result<i64, LocalAccountAuthError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| LocalAccountAuthError::InvalidTime)?;
    i64::try_from(duration.as_millis()).map_err(|_| LocalAccountAuthError::InvalidTime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_issuer_without_changing_case_or_path() {
        assert_eq!(
            normalize_issuer(" https://accounts.example/// "),
            "https://accounts.example"
        );
        assert_eq!(
            normalize_issuer("https://accounts.example/path/"),
            "https://accounts.example/path"
        );
    }

    #[test]
    fn identity_exchange_parser_requires_bounded_verified_claim_shape() {
        let expires_at = OffsetDateTime::now_utc() + time::Duration::minutes(1);
        let value = json!({
            "issuer": "https://accounts.example",
            "subject": "account-1",
            "audience": "installation-1",
            "installationId": "installation-1",
            "jti": "exchange-1",
            "expiresAt": expires_at.format(&time::format_description::well_known::Rfc3339).unwrap(),
            "email": " OPERATOR@EXAMPLE.COM ",
            "name": "Operator"
        });
        let claims = parse_identity_exchange(value).unwrap();
        assert_eq!(claims.email, "operator@example.com");
        assert!(claims.email_verified);
        assert!(parse_identity_exchange(json!({ "email": "missing" })).is_none());
    }

    #[test]
    fn exchange_request_preserves_strict_shared_contract() {
        let valid = json!({ "exchangeCode": "0123456789abcdef" });
        assert!(serde_json::from_value::<LocalServerExchangeRequest>(valid).is_ok());
        let unknown = json!({ "exchangeCode": "0123456789abcdef", "extra": true });
        assert!(serde_json::from_value::<LocalServerExchangeRequest>(unknown).is_err());
    }

    #[test]
    fn identity_verifier_allows_https_and_explicit_loopback_only() {
        assert!(
            IdentityServerExchangeVerifier::new(
                "https://accounts.example",
                "rudder-local-board",
                "installation-1",
            )
            .is_ok()
        );
        assert!(
            IdentityServerExchangeVerifier::new(
                "http://127.0.0.1:3100",
                "rudder-local-board",
                "installation-1",
            )
            .is_ok()
        );
        assert!(
            IdentityServerExchangeVerifier::new(
                "http://accounts.example",
                "rudder-local-board",
                "installation-1",
            )
            .is_err()
        );
    }

    #[test]
    fn verifier_and_owned_service_keep_the_send_sync_contract() {
        fn assert_send_sync<T: Send + Sync>() {}

        assert_send_sync::<IdentityServerExchangeVerifier>();
        assert_send_sync::<LocalAccountAuthService>();
    }

    #[test]
    fn session_cookie_uses_desktop_compatible_secure_name_and_attributes() {
        let expires = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let cookie = local_session_cookie("token+/=.sig==", expires, true).unwrap();
        assert!(cookie.starts_with("__Secure-better-auth.session_token=token%2B%2F%3D.sig%3D%3D;"));
        assert!(cookie.contains("; Path=/; HttpOnly; SameSite=Lax; Expires="));
        assert!(cookie.ends_with("; Secure"));
    }
}
