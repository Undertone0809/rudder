//! Native Better Auth email/password sign-up, sign-in and current-session
//! sign-out. Password, session and cookie contracts are pinned to the
//! installed Better Auth version transported by the startup issuer descriptor.

use super::IngressState;
use crate::{DatabaseState, native_session_auth};
use actix_web::{
    HttpRequest, HttpResponse,
    http::{Method, StatusCode, header},
    web,
};
use futures_util::StreamExt;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Map, Value, json};
use sqlx::{Pool, Postgres, Row, Transaction};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use unicode_normalization::UnicodeNormalization;
use url::Url;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const RATE_WINDOW: Duration = Duration::from_secs(10);
const RATE_LIMIT: u32 = 3;
const RATE_LIMIT_FULL: &str = "Too many requests. Please try again later.";
const DUMMY_SALT: &str = "d34db33fd34db33fd34db33fd34db33f";
const SESSION_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
const DONT_REMEMBER_TTL_SECONDS: i64 = 24 * 60 * 60;
// Bound raw and parsed request retention for signup/signin before those
// handlers can wait in the general request-admission queue. At most eight
// requests can each retain the route's 10 MiB body cap (80 MiB raw, plus
// bounded JSON/form decoding overhead). Better Auth accepts signin passwords
// without a maximum, so keep this as workflow admission rather than truncating
// or rejecting previously supported credentials.
const MAX_CONCURRENT_EMAIL_AUTH_WORKFLOWS: usize = 8;
// Better Auth's (N=2^14, r=16, p=1) scrypt uses about 32 MiB per operation.
// Keep password work independent from the larger HTTP worker/admission limits.
const MAX_CONCURRENT_PASSWORD_KDFS: usize = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum EmailAuthEndpoint {
    Registration,
    Login,
    Logout,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkflowAdmissionError {
    Saturated,
}

struct RateEntry {
    count: u32,
    last_request: Instant,
}

static RATE_LIMITS: OnceLock<Mutex<HashMap<String, RateEntry>>> = OnceLock::new();
static EMAIL_AUTH_WORKFLOW_ADMISSION: OnceLock<EmailAuthWorkflowAdmission> = OnceLock::new();
static PASSWORD_KDF_ADMISSION: OnceLock<PasswordKdfAdmission> = OnceLock::new();

#[derive(Clone)]
struct EmailAuthWorkflowAdmission {
    semaphore: Arc<Semaphore>,
}

impl EmailAuthWorkflowAdmission {
    fn new(max_active: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_active)),
        }
    }

    fn try_acquire(&self) -> Option<OwnedSemaphorePermit> {
        self.semaphore.clone().try_acquire_owned().ok()
    }
}

fn email_auth_workflow_admission() -> &'static EmailAuthWorkflowAdmission {
    EMAIL_AUTH_WORKFLOW_ADMISSION
        .get_or_init(|| EmailAuthWorkflowAdmission::new(MAX_CONCURRENT_EMAIL_AUTH_WORKFLOWS))
}

fn acquire_email_auth_workflow(
    admission: &EmailAuthWorkflowAdmission,
    endpoint: EmailAuthEndpoint,
) -> Result<Option<OwnedSemaphorePermit>, WorkflowAdmissionError> {
    if matches!(
        endpoint,
        EmailAuthEndpoint::Registration | EmailAuthEndpoint::Login
    ) {
        admission
            .try_acquire()
            .map(Some)
            .ok_or(WorkflowAdmissionError::Saturated)
    } else {
        Ok(None)
    }
}

#[derive(Clone)]
struct PasswordKdfAdmission {
    semaphore: Arc<Semaphore>,
}

impl PasswordKdfAdmission {
    fn new(max_active: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_active)),
        }
    }

    fn try_acquire(&self) -> Result<OwnedSemaphorePermit, PasswordWorkError> {
        self.semaphore
            .clone()
            .try_acquire_owned()
            .map_err(|_| PasswordWorkError::Saturated)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PasswordWorkError {
    Saturated,
    Unavailable,
}

impl From<PasswordWorkError> for SignUpError {
    fn from(error: PasswordWorkError) -> Self {
        match error {
            PasswordWorkError::Saturated => Self::KdfSaturated,
            PasswordWorkError::Unavailable => Self::Unavailable,
        }
    }
}

impl From<PasswordWorkError> for SignInError {
    fn from(error: PasswordWorkError) -> Self {
        match error {
            PasswordWorkError::Saturated => Self::KdfSaturated,
            PasswordWorkError::Unavailable => Self::Unavailable,
        }
    }
}

fn password_kdf_admission() -> &'static PasswordKdfAdmission {
    PASSWORD_KDF_ADMISSION.get_or_init(|| PasswordKdfAdmission::new(MAX_CONCURRENT_PASSWORD_KDFS))
}

fn spawn_password_work<F, R>(permit: OwnedSemaphorePermit, work: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let result = work();
        drop(permit);
        result
    })
}

pub(super) fn endpoint_for_path(path: &str) -> Option<EmailAuthEndpoint> {
    let mut decoded = path.to_owned();
    for _ in 0..4 {
        let next = percent_encoding::percent_decode_str(&decoded)
            .decode_utf8_lossy()
            .into_owned();
        if next == decoded {
            break;
        }
        decoded = next;
    }
    let path = decoded.strip_suffix('/').unwrap_or(&decoded);
    if path.eq_ignore_ascii_case("/api/auth/sign-up/email") {
        Some(EmailAuthEndpoint::Registration)
    } else if path.eq_ignore_ascii_case("/api/auth/sign-in/email") {
        Some(EmailAuthEndpoint::Login)
    } else if path.eq_ignore_ascii_case("/api/auth/sign-out") {
        Some(EmailAuthEndpoint::Logout)
    } else {
        None
    }
}

/// Match Express/Better Call's case-insensitive and trailing-slash route
/// aliases, including encoded aliases, before the wildcard proxy can see them.
pub(super) fn reserved_path(path: &str) -> bool {
    endpoint_for_path(path).is_some()
}

pub(super) async fn sign_up(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    handle(state, request, payload, EmailAuthEndpoint::Registration).await
}

pub(super) async fn sign_in(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    handle(state, request, payload, EmailAuthEndpoint::Login).await
}

pub(super) async fn sign_out(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    handle(state, request, payload, EmailAuthEndpoint::Logout).await
}

pub(super) async fn handle(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    endpoint: EmailAuthEndpoint,
) -> HttpResponse {
    if request.method() != Method::POST {
        return not_found();
    }
    if let Some(response) = crate::public_ingress::private_host_rejection(&state, &request) {
        return response;
    }
    let Some(email_config) = state
        .config
        .browser_auth
        .as_ref()
        .and_then(|auth| auth.better_auth_email.as_ref())
    else {
        return api_error(StatusCode::NOT_FOUND, "Not Found", "NOT_FOUND");
    };
    let Some(session_config) = state.config.session_auth.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Internal Server Error",
            "INTERNAL_SERVER_ERROR",
        );
    };

    if email_config.rate_limit_enabled
        && matches!(
            endpoint,
            EmailAuthEndpoint::Registration | EmailAuthEndpoint::Login
        )
        && let Some(response) = rate_limit_response(&state, &request, endpoint)
    {
        return response;
    }

    if endpoint != EmailAuthEndpoint::Logout
        && !validate_form_csrf(&request, &email_config.trusted_origins)
    {
        return csrf_error(&request, &email_config.trusted_origins);
    }
    if endpoint == EmailAuthEndpoint::Logout
        && !validate_cookie_origin(&request, &email_config.trusted_origins)
    {
        return csrf_error(&request, &email_config.trusted_origins);
    }

    // Reserve bounded signup/signin capacity before reading payload bytes or
    // waiting for general request admission. Sign-out intentionally bypasses
    // this lane so login saturation cannot block revocation.
    let _workflow_permit =
        match acquire_email_auth_workflow(email_auth_workflow_admission(), endpoint) {
            Ok(permit) => permit,
            Err(WorkflowAdmissionError::Saturated) => {
                return retryable_service_unavailable_response();
            }
        };

    let fields = if endpoint == EmailAuthEndpoint::Logout {
        // Better Auth sign-out has no body schema and accepts an empty request.
        Map::new()
    } else {
        let mut body = Vec::new();
        while let Some(chunk) = payload.next().await {
            let Ok(chunk) = chunk else {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "Invalid JSON in request body",
                    "BAD_REQUEST",
                );
            };
            if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                return api_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Payload too large",
                    "PAYLOAD_TOO_LARGE",
                );
            }
            body.extend_from_slice(&chunk);
        }
        match parse_body(&request, &body) {
            Ok(fields) => fields,
            Err(error) => return error.into_response(),
        }
    };

    match endpoint {
        EmailAuthEndpoint::Registration => {
            let Some(name_value) = fields.get("name") else {
                return validation_error(
                    "name",
                    "Invalid input: expected string, received undefined",
                );
            };
            let Some(name) = name_value.as_str() else {
                return validation_error("name", &type_error_message(name_value, "string"));
            };
            let Some(email_value) = fields.get("email") else {
                return validation_error(
                    "email",
                    "Invalid input: expected string, received undefined",
                );
            };
            let Some(email) = email_value.as_str() else {
                return validation_error("email", &type_error_message(email_value, "string"));
            };
            let Some(password_value) = fields.get("password") else {
                return validation_error(
                    "password",
                    "Invalid input: expected string, received undefined",
                );
            };
            let Some(password) = password_value.as_str() else {
                return validation_error("password", &type_error_message(password_value, "string"));
            };
            if !is_valid_email(email) {
                return validation_error("email", "Invalid email address");
            }
            if password.is_empty() {
                return validation_error(
                    "password",
                    "Too small: expected string to have >=1 characters",
                );
            }
            let password_length = password.encode_utf16().count();
            if password_length < 8 {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "Password too short",
                    "PASSWORD_TOO_SHORT",
                );
            }
            if password_length > 128 {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "Password too long",
                    "PASSWORD_TOO_LONG",
                );
            }
            let image = match fields.get("image") {
                Some(Value::String(image)) => Some(image.as_str()),
                None => None,
                Some(value) => {
                    return validation_error("image", &type_error_message(value, "string"));
                }
            };
            if let Some(value) = fields.get("callbackURL")
                && !value.is_string()
            {
                return validation_error("callbackURL", &type_error_message(value, "string"));
            }
            if let Some(value) = fields.get("rememberMe")
                && !value.is_boolean()
            {
                return validation_error("rememberMe", &type_error_message(value, "boolean"));
            }
            let callback = optional_string(&fields, "callbackURL");
            if let Some(callback) = callback
                && !callback.is_empty()
                && !is_trusted_callback(callback, &email_config.trusted_origins)
            {
                return api_error(
                    StatusCode::FORBIDDEN,
                    "Invalid callbackURL",
                    "INVALID_CALLBACK_URL",
                );
            }
            let remember_me = fields.get("rememberMe").and_then(Value::as_bool) != Some(false);

            // Better Auth validates the schema before applying disableSignUp.
            if email_config.disable_sign_up {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "Email and password sign up is not enabled",
                    "EMAIL_PASSWORD_SIGN_UP_DISABLED",
                );
            }
            let Some(_permit) = acquire_admission(&state).await else {
                return api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Internal Server Error",
                    "INTERNAL_SERVER_ERROR",
                );
            };
            let DatabaseState::Configured(pool) = &state.foundation.database else {
                return api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                    "INTERNAL_SERVER_ERROR",
                );
            };
            let normalized_email = email.to_lowercase();
            match sign_up_user(
                pool,
                &state,
                &request,
                SignUpInput {
                    email: &normalized_email,
                    name,
                    image,
                    password,
                    remember_me,
                },
            )
            .await
            {
                Ok((user, token, dont_remember)) => {
                    let body = json!({ "token": token.clone(), "user": user });
                    success_with_session(session_config, token, dont_remember, body)
                }
                Err(SignUpError::Duplicate) => api_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "User already exists. Use another email.",
                    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
                ),
                Err(SignUpError::UserInsert) => api_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Failed to create user",
                    "FAILED_TO_CREATE_USER",
                ),
                Err(SignUpError::SessionInsert) => api_error(
                    StatusCode::BAD_REQUEST,
                    "Failed to create session",
                    "FAILED_TO_CREATE_SESSION",
                ),
                Err(SignUpError::KdfSaturated) => password_kdf_overloaded_response(),
                Err(SignUpError::Unavailable) => api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                    "INTERNAL_SERVER_ERROR",
                ),
            }
        }
        EmailAuthEndpoint::Login => {
            let Some(email_value) = fields.get("email") else {
                return validation_error(
                    "email",
                    "Invalid input: expected string, received undefined",
                );
            };
            let Some(email) = email_value.as_str() else {
                return validation_error("email", &type_error_message(email_value, "string"));
            };
            let Some(password_value) = fields.get("password") else {
                return validation_error(
                    "password",
                    "Invalid input: expected string, received undefined",
                );
            };
            let Some(password) = password_value.as_str() else {
                return validation_error("password", &type_error_message(password_value, "string"));
            };
            if !is_valid_email(email) {
                return api_error(StatusCode::BAD_REQUEST, "Invalid email", "INVALID_EMAIL");
            }
            if let Some(value) = fields.get("callbackURL")
                && !value.is_string()
            {
                return validation_error("callbackURL", &type_error_message(value, "string"));
            }
            if let Some(value) = fields.get("rememberMe")
                && !value.is_boolean()
            {
                return validation_error("rememberMe", &type_error_message(value, "boolean"));
            }
            let callback = optional_string(&fields, "callbackURL");
            if let Some(callback) = callback
                && !callback.is_empty()
                && !is_trusted_callback(callback, &email_config.trusted_origins)
            {
                return api_error(
                    StatusCode::FORBIDDEN,
                    "Invalid callbackURL",
                    "INVALID_CALLBACK_URL",
                );
            }
            let remember_me = fields.get("rememberMe").and_then(Value::as_bool) != Some(false);
            let Some(_permit) = acquire_admission(&state).await else {
                return api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Internal Server Error",
                    "INTERNAL_SERVER_ERROR",
                );
            };
            let DatabaseState::Configured(pool) = &state.foundation.database else {
                return api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                    "INTERNAL_SERVER_ERROR",
                );
            };
            match sign_in_user(pool, &state, &request, email, password, remember_me).await {
                Ok((user, token, dont_remember)) => {
                    let redirect = callback.is_some_and(|value| !value.is_empty());
                    let body = json!({ "redirect": redirect, "token": token.clone(), "url": callback, "user": user });
                    let response = success_with_session(session_config, token, dont_remember, body);
                    if redirect
                        && let Some(callback) = callback
                        && let Ok(value) = header::HeaderValue::from_str(callback)
                    {
                        return add_location(response, value);
                    }
                    response
                }
                Err(SignInError::InvalidCredentials) => api_error(
                    StatusCode::UNAUTHORIZED,
                    "Invalid email or password",
                    "INVALID_EMAIL_OR_PASSWORD",
                ),
                Err(SignInError::SessionInsert) => api_error(
                    StatusCode::UNAUTHORIZED,
                    "Failed to create session",
                    "FAILED_TO_CREATE_SESSION",
                ),
                Err(SignInError::KdfSaturated) => password_kdf_overloaded_response(),
                Err(SignInError::Unavailable) => api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                    "INTERNAL_SERVER_ERROR",
                ),
            }
        }
        EmailAuthEndpoint::Logout => {
            let _permit =
                match require_sign_out_admission(state.foundation.admission.acquire().await) {
                    Ok(permit) => permit,
                    Err(SignOutAdmissionError::Unavailable) => {
                        return admission_unavailable();
                    }
                };
            if session_config.kind
                == crate::public_ingress_config::NativeSessionAuthKind::BetterAuth
                && let Some((token, _)) =
                    native_session_auth::session_token(session_config, request.headers())
            {
                let DatabaseState::Configured(pool) = &state.foundation.database else {
                    return retryable_service_unavailable_response();
                };
                if sqlx::query("DELETE FROM session WHERE token = $1")
                    .bind(token)
                    .execute(pool)
                    .await
                    .is_err()
                {
                    // Better Auth clears its cookie cache even when database
                    // deletion fails. Native sign-out fails closed here so a
                    // 200 response never claims revocation that did not occur.
                    return retryable_service_unavailable_response();
                }
            }
            sign_out_response(session_config)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SignOutAdmissionError {
    Unavailable,
}

fn require_sign_out_admission(
    admission: Result<crate::RequestPermit, crate::AdmissionError>,
) -> Result<crate::RequestPermit, SignOutAdmissionError> {
    admission.map_err(|_| SignOutAdmissionError::Unavailable)
}

#[derive(Debug)]
enum SignUpError {
    Duplicate,
    UserInsert,
    SessionInsert,
    KdfSaturated,
    Unavailable,
}

#[derive(Debug)]
enum SignInError {
    InvalidCredentials,
    SessionInsert,
    KdfSaturated,
    Unavailable,
}

struct SignUpInput<'a> {
    email: &'a str,
    name: &'a str,
    image: Option<&'a str>,
    password: &'a str,
    remember_me: bool,
}

async fn sign_up_user(
    pool: &Pool<Postgres>,
    state: &IngressState,
    request: &HttpRequest,
    input: SignUpInput<'_>,
) -> Result<(Value, String, bool), SignUpError> {
    let user_id = generate_id().map_err(|_| SignUpError::Unavailable)?;
    let account_id = generate_id().map_err(|_| SignUpError::Unavailable)?;
    let session_id = generate_id().map_err(|_| SignUpError::Unavailable)?;
    let token = generate_id().map_err(|_| SignUpError::Unavailable)?;
    let (ip, user_agent) = session_metadata(state, request);
    let mut transaction = pool.begin().await.map_err(|_| SignUpError::Unavailable)?;
    let normalized_email = input.email.to_lowercase();
    // The Better Auth schema does not enforce unique email. Serialize native
    // signups for this normalized address before checking, so two simultaneous
    // native requests cannot both create credentials and sessions. This does
    // not coordinate the separately inventoried legacy Node writer.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&normalized_email)
        .execute(&mut *transaction)
        .await
        .map_err(|_| SignUpError::Unavailable)?;
    let duplicate =
        sqlx::query_scalar::<_, String>(r#"SELECT id FROM "user" WHERE email = $1 LIMIT 1"#)
            .bind(&normalized_email)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| SignUpError::Unavailable)?;
    if duplicate.is_some() {
        return Err(SignUpError::Duplicate);
    }
    // Better Auth hashes before creating the user, inside its transaction.
    let password_kdf_permit = password_kdf_admission()
        .try_acquire()
        .map_err(SignUpError::from)?;
    let password_hash = spawn_password_work(password_kdf_permit, {
        let password = input.password.to_owned();
        move || hash_password(&password)
    })
    .await
    .map_err(|_| SignUpError::Unavailable)?
    .map_err(|_| SignUpError::Unavailable)?;
    let user = insert_user(
        &mut transaction,
        &user_id,
        input.name,
        &normalized_email,
        input.image,
    )
    .await
    .map_err(|_| SignUpError::UserInsert)?;
    if sqlx::query(
        r#"INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
           VALUES ($1, $2, 'credential', $3, $4, clock_timestamp(), clock_timestamp())"#,
    )
    .bind(account_id)
    .bind(&user_id)
    .bind(&user_id)
    .bind(password_hash)
    .execute(&mut *transaction)
    .await
    .is_err()
    {
        return Err(SignUpError::Unavailable);
    }
    if insert_session(
        &mut transaction,
        &session_id,
        &token,
        &user_id,
        input.remember_me,
        ip.as_deref(),
        user_agent.as_deref(),
    )
    .await
    .is_err()
    {
        return Err(SignUpError::SessionInsert);
    }
    transaction
        .commit()
        .await
        .map_err(|_| SignUpError::Unavailable)?;
    Ok((user, token, !input.remember_me))
}

async fn sign_in_user(
    pool: &Pool<Postgres>,
    state: &IngressState,
    request: &HttpRequest,
    email: &str,
    password: &str,
    remember_me: bool,
) -> Result<(Value, String, bool), SignInError> {
    let rows = sqlx::query(
        r#"SELECT u.id, u.name, u.email, u.email_verified, u.image,
                  to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                  to_char(u.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
                  a.password
           FROM "user" u
           LEFT JOIN account a ON a.user_id = u.id AND a.provider_id = 'credential'
           WHERE u.email = $1
           LIMIT 2"#,
    )
    .bind(email.to_lowercase())
    .fetch_all(pool)
    .await
    .map_err(|_| SignInError::Unavailable)?;
    if rows.len() != 1 {
        verify_or_dummy(None, password)
            .await
            .map_err(SignInError::from)?;
        return Err(SignInError::InvalidCredentials);
    }
    let row = &rows[0];
    let stored_password = row
        .try_get::<Option<String>, _>("password")
        .map_err(|_| SignInError::Unavailable)?;
    let Some(stored_password) = stored_password else {
        verify_or_dummy(None, password)
            .await
            .map_err(SignInError::from)?;
        return Err(SignInError::InvalidCredentials);
    };
    let valid = verify_or_dummy(Some(&stored_password), password)
        .await
        .map_err(SignInError::from)?;
    if !valid {
        return Err(SignInError::InvalidCredentials);
    }
    let user = user_from_row(row).map_err(|_| SignInError::Unavailable)?;
    let user_id = user["id"].as_str().ok_or(SignInError::Unavailable)?;
    let session_id = generate_id().map_err(|_| SignInError::Unavailable)?;
    let token = generate_id().map_err(|_| SignInError::Unavailable)?;
    let (ip, user_agent) = session_metadata(state, request);
    let mut transaction = pool.begin().await.map_err(|_| SignInError::Unavailable)?;
    if insert_session(
        &mut transaction,
        &session_id,
        &token,
        user_id,
        remember_me,
        ip.as_deref(),
        user_agent.as_deref(),
    )
    .await
    .is_err()
    {
        return Err(SignInError::SessionInsert);
    }
    transaction
        .commit()
        .await
        .map_err(|_| SignInError::Unavailable)?;
    Ok((user, token, !remember_me))
}

async fn insert_user(
    transaction: &mut Transaction<'_, Postgres>,
    id: &str,
    name: &str,
    email: &str,
    image: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let row = sqlx::query(
        r#"INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at)
           VALUES ($1, $2, $3, FALSE, $4, clock_timestamp(), clock_timestamp())
           RETURNING id, name, email, email_verified, image,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
             to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at"#,
    )
    .bind(id)
    .bind(name)
    .bind(email)
    .bind(image)
    .fetch_one(&mut **transaction)
    .await?;
    user_from_row(&row)
}

fn user_from_row(row: &sqlx::postgres::PgRow) -> Result<Value, sqlx::Error> {
    Ok(json!({
        "id": row.try_get::<String, _>("id")?,
        "name": row.try_get::<String, _>("name")?,
        "email": row.try_get::<String, _>("email")?,
        "emailVerified": row.try_get::<bool, _>("email_verified")?,
        "image": row.try_get::<Option<String>, _>("image")?,
        "createdAt": row.try_get::<String, _>("created_at")?,
        "updatedAt": row.try_get::<String, _>("updated_at")?,
    }))
}

async fn insert_session(
    transaction: &mut Transaction<'_, Postgres>,
    id: &str,
    token: &str,
    user_id: &str,
    remember_me: bool,
    ip_address: Option<&str>,
    user_agent: Option<&str>,
) -> Result<(), sqlx::Error> {
    let ttl = if remember_me {
        SESSION_TTL_SECONDS
    } else {
        DONT_REMEMBER_TTL_SECONDS
    };
    sqlx::query(
        r#"INSERT INTO session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
           VALUES ($1, clock_timestamp() + ($2::double precision * interval '1 second'), $3,
                   clock_timestamp(), clock_timestamp(), $4, $5, $6)"#,
    )
    .bind(id)
    .bind(ttl)
    .bind(token)
    .bind(ip_address)
    .bind(user_agent)
    .bind(user_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn session_metadata(
    state: &IngressState,
    request: &HttpRequest,
) -> (Option<String>, Option<String>) {
    let client_ip = state
        .config
        .forwarding_policy
        .identity(request)
        .ok()
        .map(|identity| identity.client_ip)
        .unwrap_or_default();
    let user_agent = request
        .headers()
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    (Some(client_ip), Some(user_agent))
}

async fn acquire_admission(state: &IngressState) -> Option<crate::RequestPermit> {
    state.foundation.admission.acquire().await.ok()
}

fn admission_unavailable() -> HttpResponse {
    api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Service Unavailable",
        "SERVICE_UNAVAILABLE",
    )
}

fn retryable_service_unavailable_response() -> HttpResponse {
    let mut response = admission_unavailable();
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, header::HeaderValue::from_static("1"));
    response
}

fn password_kdf_overloaded_response() -> HttpResponse {
    retryable_service_unavailable_response()
}

async fn verify_or_dummy(stored: Option<&str>, password: &str) -> Result<bool, PasswordWorkError> {
    let permit = password_kdf_admission().try_acquire()?;
    let password = password.to_owned();
    let stored = stored.map(str::to_owned);
    spawn_password_work(permit, move || match stored.as_deref() {
        Some(hash) => verify_password(hash, &password),
        None => {
            let _ = derive_password(&password, DUMMY_SALT.as_bytes())?;
            Ok(false)
        }
    })
    .await
    .map_err(|_| PasswordWorkError::Unavailable)?
    .map_err(|_| PasswordWorkError::Unavailable)
}

fn hash_password(password: &str) -> Result<String, ()> {
    let mut salt = [0u8; 16];
    SystemRandom::new().fill(&mut salt).map_err(|_| ())?;
    let salt = hex_lower(&salt);
    let derived = derive_password(password, salt.as_bytes())?;
    Ok(format!("{salt}:{}", hex_lower(&derived)))
}

fn verify_password(encoded: &str, password: &str) -> Result<bool, ()> {
    let mut parts = encoded.split(':');
    let salt = parts.next().unwrap_or_default();
    let encoded_key = parts.next().unwrap_or_default();
    // Better Auth destructures `hash.split(":")` into its first two pieces.
    // Preserve that parser behavior for credentials already stored by it.
    if salt.is_empty() || encoded_key.is_empty() {
        let _ = derive_password(password, DUMMY_SALT.as_bytes())?;
        return Ok(false);
    }
    let Some(expected) = decode_hex_64(encoded_key) else {
        let _ = derive_password(password, DUMMY_SALT.as_bytes())?;
        return Ok(false);
    };
    let actual = derive_password(password, salt.as_bytes())?;
    Ok(actual.ct_eq(&expected).unwrap_u8() == 1)
}

fn derive_password(password: &str, salt: &[u8]) -> Result<[u8; 64], ()> {
    let normalized = password.nfkc().collect::<String>();
    let params = scrypt::Params::new(14, 16, 1).map_err(|_| ())?;
    let mut output = [0u8; 64];
    scrypt::scrypt(normalized.as_bytes(), salt, &params, &mut output).map_err(|_| ())?;
    Ok(output)
}

fn decode_hex_64(value: &str) -> Option<[u8; 64]> {
    if value.len() != 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut decoded = [0u8; 64];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
    }
    Some(decoded)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn hex_lower(value: &[u8]) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn generate_id() -> Result<String, ()> {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let rng = SystemRandom::new();
    let mut id = String::with_capacity(32);
    let mut random = [0u8; 64];
    while id.len() < 32 {
        rng.fill(&mut random).map_err(|_| ())?;
        for byte in random {
            // Reject the tail so every one of the Better Auth alphabet's 62
            // symbols has the same probability instead of modulo bias.
            if byte >= 248 {
                continue;
            }
            id.push(ALPHABET[usize::from(byte % 62)] as char);
            if id.len() == 32 {
                break;
            }
        }
    }
    Ok(id)
}

fn success_with_session(
    config: &crate::public_ingress_config::NativeSessionAuthConfig,
    token: String,
    dont_remember: bool,
    body: Value,
) -> HttpResponse {
    let Ok(signed) = native_session_auth::sign_session_token(&token, &config.secret) else {
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
            "INTERNAL_SERVER_ERROR",
        );
    };
    let mut response = HttpResponse::Ok();
    let mut cookie = format!(
        "{}={}",
        config.session_cookie_name(),
        encode_cookie_component(&signed)
    );
    cookie.push_str("; Path=/; HttpOnly; SameSite=Lax");
    if !dont_remember {
        cookie.push_str("; Max-Age=604800");
    }
    if config.secure_cookie {
        cookie.push_str("; Secure");
    }
    let cookie = match header::HeaderValue::from_str(&cookie) {
        Ok(cookie) => cookie,
        Err(_) => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
                "INTERNAL_SERVER_ERROR",
            );
        }
    };
    response.insert_header((header::SET_COOKIE, cookie));
    if dont_remember {
        let Ok(signed) = native_session_auth::sign_session_token("true", &config.secret) else {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
                "INTERNAL_SERVER_ERROR",
            );
        };
        let mut cookie = format!(
            "{}={}; Path=/; HttpOnly; SameSite=Lax",
            config.dont_remember_cookie_name(),
            encode_cookie_component(&signed)
        );
        if config.secure_cookie {
            cookie.push_str("; Secure");
        }
        let Ok(cookie) = header::HeaderValue::from_str(&cookie) else {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal Server Error",
                "INTERNAL_SERVER_ERROR",
            );
        };
        response.append_header((header::SET_COOKIE, cookie));
    }
    response
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(body)
}

fn sign_out_response(
    config: &crate::public_ingress_config::NativeSessionAuthConfig,
) -> HttpResponse {
    let mut response = HttpResponse::Ok();
    for name in [
        config.session_cookie_name(),
        if config.secure_cookie {
            "__Secure-better-auth.session_data"
        } else {
            "better-auth.session_data"
        },
        config.dont_remember_cookie_name(),
    ] {
        let mut value = format!(
            "{name}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
        );
        if config.secure_cookie {
            value.push_str("; Secure");
        }
        if let Ok(cookie) = header::HeaderValue::from_str(&value) {
            response.append_header((header::SET_COOKIE, cookie));
        }
    }
    response
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(json!({ "success": true }))
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

fn add_location(mut response: HttpResponse, value: header::HeaderValue) -> HttpResponse {
    response.headers_mut().insert(header::LOCATION, value);
    response
}

#[derive(Debug, Eq, PartialEq)]
enum BodyParseError {
    MissingContentType,
    UnsupportedMediaType(String),
    InvalidJson,
    InvalidObject(String),
}

impl BodyParseError {
    fn into_response(self) -> HttpResponse {
        match self {
            Self::MissingContentType => api_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Content-Type is required. Allowed types: application/x-www-form-urlencoded, application/json",
                "UNSUPPORTED_MEDIA_TYPE",
            ),
            Self::UnsupportedMediaType(content_type) => api_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                &format!(
                    "Content-Type \"{content_type}\" is not allowed. Allowed types: application/x-www-form-urlencoded, application/json"
                ),
                "UNSUPPORTED_MEDIA_TYPE",
            ),
            Self::InvalidJson => api_error(
                StatusCode::BAD_REQUEST,
                "Invalid JSON in request body",
                "BAD_REQUEST",
            ),
            Self::InvalidObject(message) => validation_error("body", &message),
        }
    }
}

fn parse_body(request: &HttpRequest, body: &[u8]) -> Result<Map<String, Value>, BodyParseError> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let normalized_content_type = content_type.to_ascii_lowercase();
    let media_type = normalized_content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    let has_body = !body.is_empty()
        || request.headers().contains_key(header::TRANSFER_ENCODING)
        || request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > 0);
    if !has_body {
        return Ok(Map::new());
    }
    let allowed_media_type = media_type.contains("application/json")
        || media_type.contains("application/x-www-form-urlencoded");
    if !allowed_media_type {
        return if content_type.is_empty() {
            Err(BodyParseError::MissingContentType)
        } else {
            Err(BodyParseError::UnsupportedMediaType(
                content_type.to_owned(),
            ))
        };
    }
    let value = if media_type.starts_with("application/")
        && (media_type == "application/json" || media_type.ends_with("+json"))
    {
        serde_json::from_slice::<Value>(body).map_err(|_| BodyParseError::InvalidJson)?
    } else if media_type.contains("application/x-www-form-urlencoded") {
        let fields = url::form_urlencoded::parse(body).into_owned().fold(
            Map::new(),
            |mut fields, (key, value)| {
                fields.insert(key, Value::String(value));
                fields
            },
        );
        Value::Object(fields)
    } else {
        // The installed Better Call body parser accepts allowed media-type
        // substrings before applying its JSON/form parser. For malformed but
        // allowed labels it returns text, which then fails the object schema.
        Value::String(String::from_utf8_lossy(body).into_owned())
    };
    value
        .as_object()
        .cloned()
        .ok_or_else(|| BodyParseError::InvalidObject(type_error_message(&value, "object")))
}

fn optional_string<'a>(fields: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    fields.get(key).and_then(Value::as_str)
}

fn validation_error(field: &str, message: &str) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({
        "message": format!("[body.{field}] {message}"),
        "code": "VALIDATION_ERROR",
    }))
}

fn type_error_message(value: &Value, expected: &str) -> String {
    let received = match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };
    format!("Invalid input: expected {expected}, received {received}")
}

fn is_valid_email(email: &str) -> bool {
    // Pinned `z.email()` regex from the installed Better Auth 1.6.23 bundle:
    // /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/
    let Some((local, domain)) = email.rsplit_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.starts_with('.')
        || local.contains("..")
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_'+-.".contains(&byte))
        || !local
            .as_bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || b"_+-".contains(byte))
    {
        return false;
    }
    let labels: Vec<_> = domain.split('.').collect();
    labels.len() >= 2
        && labels[..labels.len() - 1].iter().all(|label| {
            !label.is_empty()
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        && labels.last().is_some_and(|label| {
            label.len() >= 2 && label.bytes().all(|byte| byte.is_ascii_alphabetic())
        })
}

fn validate_form_csrf(request: &HttpRequest, trusted: &[String]) -> bool {
    if request.headers().contains_key(header::COOKIE) {
        return validate_cookie_origin(request, trusted);
    }
    let site = request
        .headers()
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok());
    let mode = request
        .headers()
        .get("sec-fetch-mode")
        .and_then(|value| value.to_str().ok());
    let dest = request
        .headers()
        .get("sec-fetch-dest")
        .and_then(|value| value.to_str().ok());
    let has_fetch_metadata = [site, mode, dest]
        .into_iter()
        .flatten()
        .any(|value| !value.trim().is_empty());
    if site == Some("cross-site") && mode == Some("navigate") {
        return false;
    }
    if has_fetch_metadata {
        return validate_origin_value(request, trusted, true);
    }
    if request.headers().contains_key(header::ORIGIN)
        || request.headers().contains_key(header::REFERER)
    {
        return validate_origin_value(request, trusted, true);
    }
    true
}

fn validate_cookie_origin(request: &HttpRequest, trusted: &[String]) -> bool {
    if !request.headers().contains_key(header::COOKIE) {
        return true;
    }
    validate_origin_value(request, trusted, true)
}

fn validate_origin_value(request: &HttpRequest, trusted: &[String], force: bool) -> bool {
    if !force && !request.headers().contains_key(header::COOKIE) {
        return true;
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .or_else(|| request.headers().get(header::REFERER))
        .and_then(|value| value.to_str().ok());
    let Some(origin) = origin.filter(|value| !value.is_empty() && *value != "null") else {
        return false;
    };
    trusted
        .iter()
        .any(|pattern| origin_matches(origin, pattern))
}

fn origin_matches(value: &str, pattern: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return false;
    }
    let candidate = url.origin().ascii_serialization();
    let wildcard_pattern = if pattern.contains("://") {
        candidate.clone()
    } else {
        let Some(host) = url.host() else {
            return false;
        };
        let mut host = match host {
            url::Host::Domain(domain) => domain.to_owned(),
            url::Host::Ipv4(address) => address.to_string(),
            url::Host::Ipv6(address) => format!("[{address}]"),
        };
        if let Some(port) = url.port() {
            host.push(':');
            host.push_str(&port.to_string());
        }
        host
    };
    if pattern.contains('*') || pattern.contains('?') {
        wildcard_match(pattern.as_bytes(), wildcard_pattern.as_bytes())
    } else {
        pattern == candidate
    }
}

fn wildcard_match(pattern: &[u8], value: &[u8]) -> bool {
    let (mut p, mut v, mut star, mut retry) = (0, 0, None, 0);
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(star_index) = star {
            retry += 1;
            v = retry;
            p = star_index + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn is_trusted_callback(callback: &str, trusted: &[String]) -> bool {
    if let Some(tail) = callback.strip_prefix('/') {
        if tail.starts_with('/')
            || tail.starts_with('\\')
            || tail.starts_with("%2f")
            || tail.starts_with("%5c")
        {
            return false;
        }
        let (path, query) = callback.split_once('?').unwrap_or((callback, ""));
        return path
            .bytes()
            .skip(1)
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.+/@".contains(&byte))
            && query
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-.+/=&%@".contains(&byte));
    }
    if trusted
        .iter()
        .any(|pattern| origin_matches(callback, pattern))
    {
        return true;
    }
    let Ok(url) = Url::parse(callback) else {
        return false;
    };
    let scheme = url.scheme();
    if url.host().is_none()
        || matches!(
            scheme,
            "http" | "https" | "javascript" | "data" | "vbscript" | "file"
        )
    {
        return false;
    }
    // Better Auth allows explicitly trusted non-web callback schemes for
    // app deep links. Require a matching explicit scheme+host pattern so a
    // wildcard catch-all cannot make javascript:/data: or opaque URLs trusted.
    let explicit_scheme_prefix = format!("{scheme}://");
    trusted.iter().any(|pattern| {
        if !pattern.starts_with(&explicit_scheme_prefix) {
            return false;
        }
        if pattern.contains('*') || pattern.contains('?') {
            wildcard_match(pattern.as_bytes(), callback.as_bytes())
        } else {
            callback.starts_with(pattern)
        }
    })
}

fn csrf_error(request: &HttpRequest, _trusted: &[String]) -> HttpResponse {
    if !request.headers().contains_key(header::COOKIE)
        && request
            .headers()
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
            == Some("cross-site")
        && request
            .headers()
            .get("sec-fetch-mode")
            .and_then(|value| value.to_str().ok())
            == Some("navigate")
    {
        api_error(
            StatusCode::FORBIDDEN,
            "Cross-site navigation login blocked. This request appears to be a CSRF attack.",
            "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
        )
    } else if request
        .headers()
        .get(header::ORIGIN)
        .or_else(|| request.headers().get(header::REFERER))
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| value.is_empty() || value == "null")
    {
        api_error(
            StatusCode::FORBIDDEN,
            "Missing or null Origin",
            "MISSING_OR_NULL_ORIGIN",
        )
    } else {
        api_error(StatusCode::FORBIDDEN, "Invalid origin", "INVALID_ORIGIN")
    }
}

fn rate_limit_response(
    state: &IngressState,
    request: &HttpRequest,
    endpoint: EmailAuthEndpoint,
) -> Option<HttpResponse> {
    let path = match endpoint {
        EmailAuthEndpoint::Registration => "/sign-up/email",
        EmailAuthEndpoint::Login => "/sign-in/email",
        EmailAuthEndpoint::Logout => return None,
    };
    let ip = rate_limit_client_ip(&state.config.forwarding_policy, request);
    let key = format!("{ip}|{path}");
    let now = Instant::now();
    let mut rates = RATE_LIMITS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    rates.retain(|_, entry| now.duration_since(entry.last_request) <= RATE_WINDOW);
    if rates.len() >= 100_000 {
        let overflow = rates.len() - 99_999;
        for key in rates.keys().take(overflow).cloned().collect::<Vec<_>>() {
            rates.remove(&key);
        }
    }
    let entry = rates.entry(key).or_insert(RateEntry {
        count: 0,
        last_request: now,
    });
    if now.duration_since(entry.last_request) > RATE_WINDOW {
        entry.count = 0;
    }
    if entry.count >= RATE_LIMIT {
        let remaining =
            RATE_WINDOW.as_secs_f64() - now.duration_since(entry.last_request).as_secs_f64();
        let retry_after = remaining.ceil().max(0.0) as u64;
        let mut response = api_error(StatusCode::TOO_MANY_REQUESTS, RATE_LIMIT_FULL, "");
        if let Ok(value) = header::HeaderValue::from_str(&retry_after.to_string()) {
            response
                .headers_mut()
                .insert(header::HeaderName::from_static("x-retry-after"), value);
        }
        return Some(response);
    }
    entry.count += 1;
    entry.last_request = now;
    None
}

fn rate_limit_client_ip(
    policy: &crate::public_ingress_forwarding::ForwardingPolicy,
    request: &HttpRequest,
) -> String {
    policy
        .identity(request)
        .map(|identity| identity.client_ip)
        .unwrap_or_else(|_| "no-trusted-ip".to_owned())
}

fn api_error(status: StatusCode, message: &str, code: &str) -> HttpResponse {
    let mut body = serde_json::Map::new();
    body.insert("message".into(), Value::String(message.to_owned()));
    if !code.is_empty() {
        body.insert("code".into(), Value::String(code.to_owned()));
    }
    HttpResponse::build(status).json(Value::Object(body))
}

fn not_found() -> HttpResponse {
    HttpResponse::NotFound().body("Not Found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    // Derived against @better-auth/utils 0.4.2's Node implementation using
    // its UTF-8 hex salt string and scrypt N=16384, r=16, p=1, dkLen=64.
    const ASCII_VECTOR: &str = "00112233445566778899aabbccddeeff:77d2cfe6d81ee77f1ee1547073e08a2c08715de6288c45cabe867387b52687632195902a0b194462fcfb22d5d5409f8c07301e345fc6cdeb5e6a8abd07469c30";
    const NFKC_VECTOR: &str = "ffeeddccbbaa99887766554433221100:2c85c7701fe49ea68609acf66584a40ca241570957601b39be0cf8298fc49e65a60a33a4875fc45a0fbf9243b9e5e62998dc1cc28d9595dbf8728070fe38ee46";

    #[test]
    fn verifies_better_auth_scrypt_vectors_and_nfkc_normalization() {
        assert!(verify_password(ASCII_VECTOR, "fixed-better-auth-vector-password").unwrap());
        assert!(
            verify_password(
                &format!("{ASCII_VECTOR}:extra"),
                "fixed-better-auth-vector-password"
            )
            .unwrap()
        );
        assert!(verify_password(NFKC_VECTOR, "Café-123456").unwrap());
        assert!(verify_password(NFKC_VECTOR, "Cafe\u{301}-123456").unwrap());
        assert!(!verify_password(ASCII_VECTOR, "a-different-password").unwrap());
        assert!(!verify_password("malformed", "fixed-better-auth-vector-password").unwrap());
        assert!(
            !verify_password(&format!("{}:{}", "0".repeat(32), "g".repeat(128)), "test").unwrap()
        );
        let (salt, key) = ASCII_VECTOR.split_once(':').unwrap();
        let uppercase_key = key.to_ascii_uppercase();
        assert!(
            !verify_password(
                &format!("{salt}:{uppercase_key}"),
                "fixed-better-auth-vector-password"
            )
            .unwrap()
        );
    }

    #[test]
    fn uses_installed_better_auth_email_and_relative_callback_contracts() {
        for email in ["first.last@example.test", "a-@example.test", "a@a-.test"] {
            assert!(
                is_valid_email(email),
                "expected {email} to match pinned Zod email"
            );
        }
        for email in [
            ".first@example.test",
            "first..last@example.test",
            "a'@example.test",
            "a@example.c",
        ] {
            assert!(
                !is_valid_email(email),
                "expected {email} to fail pinned Zod email"
            );
        }
        assert!(is_trusted_callback("/settings?tab=auth&next=%2Fhome", &[]));
        assert!(!is_trusted_callback("//attacker.example.test", &[]));
        assert!(!is_trusted_callback("/%2f%2fattacker.example.test", &[]));
        assert!(!is_trusted_callback("/settings#fragment", &[]));
    }

    #[tokio::test]
    async fn cli_without_origin_still_reaches_content_type_validation() {
        let request = TestRequest::post()
            .insert_header((header::CONTENT_TYPE, "text/plain"))
            .to_http_request();
        assert!(validate_form_csrf(&request, &[]));
        let response = parse_body(&request, b"name=cli")
            .unwrap_err()
            .into_response();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({
                "message": "Content-Type \"text/plain\" is not allowed. Allowed types: application/x-www-form-urlencoded, application/json",
                "code": "UNSUPPORTED_MEDIA_TYPE"
            })
        );
    }

    #[test]
    fn rate_limit_ip_ignores_untrusted_forwarded_headers_and_uses_trusted_proxy_chain() {
        let untrusted = TestRequest::default()
            .peer_addr("192.0.2.7:4000".parse().unwrap())
            .insert_header(("x-forwarded-for", "198.51.100.4"))
            .to_http_request();
        assert_eq!(
            rate_limit_client_ip(
                &crate::public_ingress_forwarding::ForwardingPolicy::default(),
                &untrusted
            ),
            "192.0.2.7"
        );

        let trusted = TestRequest::default()
            .peer_addr("127.0.0.1:4000".parse().unwrap())
            .insert_header(("x-forwarded-for", "203.0.113.99, 198.51.100.7, 192.0.2.1"))
            .insert_header(("x-forwarded-proto", "https"))
            .to_http_request();
        let policy =
            crate::public_ingress_forwarding::ForwardingPolicy::parse("127.0.0.1,192.0.2.1")
                .unwrap();
        assert_eq!(rate_limit_client_ip(&policy, &trusted), "198.51.100.7");

        let malformed_trusted = TestRequest::default()
            .peer_addr("127.0.0.1:4000".parse().unwrap())
            .insert_header(("x-forwarded-for", "198.51.100.7:80"))
            .insert_header(("x-forwarded-proto", "https"))
            .to_http_request();
        assert_eq!(
            rate_limit_client_ip(&policy, &malformed_trusted),
            "no-trusted-ip"
        );
    }

    #[test]
    fn validation_body_reports_the_actual_non_object_json_type() {
        assert_eq!(
            type_error_message(&Value::Null, "object"),
            "Invalid input: expected object, received null"
        );
        assert_eq!(
            type_error_message(&json!([]), "object"),
            "Invalid input: expected object, received array"
        );
    }

    #[test]
    fn email_routes_are_exactly_reserved_with_case_and_slash_aliases() {
        for path in [
            "/api/auth/sign-up/email",
            "/API/AUTH/SIGN-IN/EMAIL/",
            "/api/auth/sign-out/",
        ] {
            assert!(reserved_path(path));
        }
        for path in [
            "/api/auth/get-session",
            "/api/auth/update-user",
            "/api/auth/sign-out/extra",
        ] {
            assert!(!reserved_path(path));
        }
    }

    #[test]
    fn cookie_origin_check_allows_cli_without_origin_but_blocks_missing_or_wrong_browser_origin() {
        let trusted = vec!["https://app.example.test".to_owned()];
        let cli = TestRequest::post().to_http_request();
        assert!(validate_form_csrf(&cli, &trusted));

        let missing_origin_with_cookie = TestRequest::post()
            .insert_header((header::COOKIE, "existing=1"))
            .to_http_request();
        assert!(!validate_form_csrf(&missing_origin_with_cookie, &trusted));

        let wrong_origin = TestRequest::post()
            .insert_header((header::ORIGIN, "https://attacker.example.test"))
            .insert_header((header::COOKIE, "existing=1"))
            .to_http_request();
        assert!(!validate_form_csrf(&wrong_origin, &trusted));

        let trusted_origin = TestRequest::post()
            .insert_header((header::ORIGIN, "https://app.example.test"))
            .insert_header(("sec-fetch-site", "same-origin"))
            .to_http_request();
        assert!(validate_form_csrf(&trusted_origin, &trusted));

        let cross_site_navigation = TestRequest::post()
            .insert_header(("sec-fetch-site", "cross-site"))
            .insert_header(("sec-fetch-mode", "navigate"))
            .to_http_request();
        assert!(!validate_form_csrf(&cross_site_navigation, &trusted));
    }

    #[test]
    fn trusted_origin_patterns_and_callback_paths_match_better_auth_rules() {
        assert!(origin_matches(
            "https://sub.example.test/path",
            "https://*.example.test"
        ));
        assert!(!origin_matches(
            "https://example.test/path",
            "https://*.example.test"
        ));
        assert!(origin_matches(
            "https://sub.example.test:8443/path",
            "*.example.test:8443"
        ));
        assert!(!origin_matches(
            "https://sub.example.test:8443/path",
            "*.example.test"
        ));
        assert!(origin_matches(
            "https://sub.example.test:443/path",
            "*.example.test"
        ));
        assert!(origin_matches(
            "https://[2001:db8::1]:8443/path",
            "[2001:db8::1]:*"
        ));
        assert!(is_trusted_callback("/settings?tab=auth", &[]));
        assert!(!is_trusted_callback("//attacker.example.test", &[]));
        assert!(!is_trusted_callback("https://attacker.example.test", &[]));
        assert!(!origin_matches("javascript:alert(1)", "*"));
        assert!(!origin_matches("javascript:alert(1)", "javascript:*"));
        assert!(!is_trusted_callback(
            "javascript:alert(1)",
            &["*".to_owned()]
        ));
        assert!(!is_trusted_callback(
            "javascript:alert(1)",
            &["javascript:*".to_owned()]
        ));
        assert!(!is_trusted_callback(
            "data:text/html,unsafe",
            &["*".to_owned()]
        ));
        assert!(!is_trusted_callback(
            "file://localhost/etc/passwd",
            &["*".to_owned()]
        ));
        assert!(!is_trusted_callback(
            "rudder://login/callback",
            &["*".to_owned()]
        ));
        assert!(is_trusted_callback(
            "rudder://login/callback",
            &["rudder://login".to_owned()]
        ));
        assert!(is_trusted_callback(
            "https://sub.example.test:8443/login",
            &["*.example.test:8443".to_owned()]
        ));
        assert!(!is_trusted_callback(
            "https://sub.example.test:8443/login",
            &["*.example.test".to_owned()]
        ));
    }

    #[tokio::test]
    async fn saturated_request_admission_fails_sign_out_without_success_response() {
        let admission = std::sync::Arc::new(crate::RequestAdmission::new(1, 0));
        let _active = admission.acquire().await.unwrap();
        let saturated = admission.acquire().await;
        assert!(matches!(&saturated, Err(crate::AdmissionError::QueueFull)));

        let response = match require_sign_out_admission(saturated) {
            Ok(_permit) => panic!("saturated sign-out admission must be rejected"),
            Err(SignOutAdmissionError::Unavailable) => admission_unavailable(),
        };
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "message": "Service Unavailable", "code": "SERVICE_UNAVAILABLE" })
        );
    }

    #[tokio::test]
    async fn saturated_email_auth_lane_rejects_before_body_or_general_admission() {
        let workflow = EmailAuthWorkflowAdmission::new(1);
        let _active = workflow.try_acquire().unwrap();
        let general = std::sync::Arc::new(crate::RequestAdmission::new(1, 0));
        for endpoint in [EmailAuthEndpoint::Registration, EmailAuthEndpoint::Login] {
            let mut body_parse_started = false;
            let mut database_started = false;

            let response = match acquire_email_auth_workflow(&workflow, endpoint) {
                Err(WorkflowAdmissionError::Saturated) => retryable_service_unavailable_response(),
                Ok(_permit) => {
                    body_parse_started = true;
                    let _request_permit = general.acquire().await.unwrap();
                    database_started = true;
                    HttpResponse::Ok().finish()
                }
            };

            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .unwrap()
                    .to_str()
                    .unwrap(),
                "1"
            );
            assert!(!body_parse_started);
            assert!(!database_started);
            assert_eq!(general.counts(), (0, 0));
            let body = actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({ "message": "Service Unavailable", "code": "SERVICE_UNAVAILABLE" })
            );
        }

        // Login saturation must never consume or reject the sign-out lane.
        assert!(
            acquire_email_auth_workflow(&workflow, EmailAuthEndpoint::Logout)
                .unwrap()
                .is_none()
        );
    }

    #[actix_web::test]
    async fn saturated_signin_route_rejects_before_payload_parser_or_request_admission() {
        use actix_web::{App, test};

        let workflow = email_auth_workflow_admission();
        let active: Vec<_> = (0..MAX_CONCURRENT_EMAIL_AUTH_WORKFLOWS)
            .map(|_| {
                workflow
                    .try_acquire()
                    .expect("reserve every auth workflow slot")
            })
            .collect();

        let mut config = crate::public_ingress_config::PublicIngressConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:1",
            "native-email-auth-ingress-key-for-test",
        )
        .unwrap();
        let secret = "native-email-auth-session-secret-for-test";
        let mut browser_auth = crate::browser_auth::BrowserAuthConfig::required(
            secret.as_bytes(),
            false,
            crate::browser_auth::SessionPolicy::BetterAuth,
        )
        .unwrap();
        browser_auth.better_auth_email = Some(crate::browser_auth::BetterAuthEmailConfig {
            trusted_origins: vec!["https://app.example.test".to_owned()],
            disable_sign_up: false,
            rate_limit_enabled: false,
        });
        config.browser_auth = Some(browser_auth);
        config.session_auth = Some(
            crate::public_ingress_config::NativeSessionAuthConfig::new(
                crate::public_ingress_config::NativeSessionAuthKind::BetterAuth,
                secret,
                false,
                "native-email-auth-assertion-key-for-tests",
            )
            .unwrap(),
        );

        let foundation = Arc::new(crate::AppState::new(crate::ServerConfig::default()).unwrap());
        let state = web::Data::new(IngressState {
            foundation: foundation.clone(),
            config,
            local_account: None,
        });
        let app = test::init_service(
            App::new()
                .app_data(state)
                .route("/api/auth/sign-in/email", web::post().to(sign_in)),
        )
        .await;
        let response = test::call_service(
            &app,
            TestRequest::post()
                .uri("/api/auth/sign-in/email")
                .insert_header((header::ORIGIN, "https://app.example.test"))
                .insert_header((header::CONTENT_TYPE, "text/plain"))
                .set_payload("body parsing must not run")
                .to_request(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response
                .headers()
                .get(header::RETRY_AFTER)
                .unwrap()
                .to_str()
                .unwrap(),
            "1"
        );
        assert_eq!(foundation.admission.counts(), (0, 0));
        drop(active);
    }

    #[tokio::test]
    async fn password_kdf_admission_rejects_overload_with_retryable_response() {
        let admission = PasswordKdfAdmission::new(1);
        let _active = admission.try_acquire().unwrap();
        assert!(matches!(
            admission.try_acquire(),
            Err(PasswordWorkError::Saturated)
        ));

        let response = password_kdf_overloaded_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response
                .headers()
                .get(header::RETRY_AFTER)
                .unwrap()
                .to_str()
                .unwrap(),
            "1"
        );
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "message": "Service Unavailable", "code": "SERVICE_UNAVAILABLE" })
        );
    }

    #[test]
    fn dropped_password_work_waiter_keeps_queued_and_running_slot_reserved() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let admission = PasswordKdfAdmission::new(1);
            let permit = admission.try_acquire().unwrap();
            let (blocker_started_tx, blocker_started_rx) = std::sync::mpsc::channel();
            let (blocker_release_tx, blocker_release_rx) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                blocker_started_tx.send(()).unwrap();
                blocker_release_rx.recv().unwrap();
            });
            blocker_started_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap();

            let (work_started_tx, work_started_rx) = std::sync::mpsc::channel();
            let (work_release_tx, work_release_rx) = std::sync::mpsc::channel();
            let (work_finished_tx, work_finished_rx) = tokio::sync::oneshot::channel();
            let waiter = spawn_password_work(permit, move || {
                work_started_tx.send(()).unwrap();
                work_release_rx.recv().unwrap();
                let _ = work_finished_tx.send(());
            });
            drop(waiter); // Dropping the async caller detaches started/queued blocking work.

            assert!(matches!(
                admission.try_acquire(),
                Err(PasswordWorkError::Saturated)
            ));
            blocker_release_tx.send(()).unwrap();
            blocker.await.unwrap();
            work_started_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
            assert!(matches!(
                admission.try_acquire(),
                Err(PasswordWorkError::Saturated)
            ));
            work_release_tx.send(()).unwrap();
            work_finished_rx.await.unwrap();

            let permit = tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    if let Ok(permit) = admission.try_acquire() {
                        break permit;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("KDF slot should return after blocking work ends");
            drop(permit);
        });
    }

    #[test]
    fn forwarded_host_never_becomes_a_trusted_origin() {
        let trusted = vec!["https://app.example.test".to_owned()];
        let request = TestRequest::post()
            .insert_header((header::HOST, "app.example.test"))
            .insert_header(("x-forwarded-host", "app.example.test"))
            .insert_header((header::ORIGIN, "https://attacker.example.test"))
            .insert_header((header::COOKIE, "existing=1"))
            .to_http_request();
        assert!(!validate_cookie_origin(&request, &trusted));
    }
}
