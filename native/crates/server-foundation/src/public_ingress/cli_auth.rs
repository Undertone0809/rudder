//! Native authority for the CLI Board-key challenge lifecycle.
//!
//! Challenge and key rows use the installed schema. Raw challenge secrets and
//! Board API tokens are returned only at issuance; persistence receives SHA-256
//! digests and compares challenge digests in constant time.

// Actix responses are the error contract at this HTTP boundary. Boxing them
// would add an allocation without reducing handlers whose success is a response.
#![allow(clippy::result_large_err)]

mod persistence;

use crate::browser_auth::{self, BrowserActor, BrowserAuthConfig, BrowserAuthError};
use crate::public_ingress_config::PublicIngressConfig;
use crate::{DatabaseState, public_ingress_config::NativeIdentityAuthConfig};
use actix_web::{
    HttpRequest, HttpResponse,
    http::{Method, StatusCode, header},
    web,
};
use futures_util::StreamExt;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::fmt::Write as _;
use url::Url;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const NO_STORE: &str = "private, no-store, max-age=0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Endpoint {
    Create,
    Poll,
    Approve,
    Cancel,
    Me,
    RevokeCurrent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChallengeInput {
    command: String,
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default = "default_access")]
    requested_access: String,
    #[serde(default)]
    requested_company_id: Option<String>,
}

#[derive(Deserialize)]
struct ResolveChallengeInput {
    token: String,
}

#[derive(Clone)]
struct CliActor {
    user_id: String,
    source: String,
    session_id: String,
}

impl From<BrowserActor> for CliActor {
    fn from(actor: BrowserActor) -> Self {
        Self {
            user_id: actor.user_id().to_owned(),
            source: actor.source().to_owned(),
            session_id: actor.session_id().to_owned(),
        }
    }
}

fn default_access() -> String {
    "board".to_owned()
}

/// Determine the verifier used by these handlers even in local-trusted
/// deployments, where the old Express router was available without a Better
/// Auth issuer. Session auth transports the same session table; local implicit
/// auth is enabled only by the already validated identity configuration.
pub(super) fn browser_auth_from_config(
    config: &PublicIngressConfig,
) -> Result<Option<BrowserAuthConfig>, &'static str> {
    if let Some(browser_auth) = config.browser_auth.as_ref() {
        return Ok(Some(browser_auth.clone()));
    }
    if let Some(session) = config.session_auth.as_ref() {
        return Ok(Some(BrowserAuthConfig::from_validated_session_auth(
            session,
        )));
    }
    if config
        .identity_auth
        .as_ref()
        .is_some_and(|identity: &NativeIdentityAuthConfig| identity.local_implicit_enabled)
    {
        return BrowserAuthConfig::local_implicit(
            config.listen_addr,
            &config.deployment_mode,
            "private",
            "optional",
        )
        .map(Some)
        .map_err(|_| "configured local implicit identity cannot be used by CLI auth");
    }
    Ok(None)
}

pub(super) fn endpoint_for_path(path: &str) -> Option<Endpoint> {
    let decoded = decoded_path(path);
    let parts: Vec<_> = decoded.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() < 3
        || !parts[0].eq_ignore_ascii_case("api")
        || !parts[1].eq_ignore_ascii_case("cli-auth")
    {
        return None;
    }
    if parts[2].eq_ignore_ascii_case("challenges") {
        match parts.as_slice() {
            [_, _, _] => Some(Endpoint::Create),
            [_, _, _, id] if !id.is_empty() => Some(Endpoint::Poll),
            [_, _, _, id, action] if !id.is_empty() => {
                if action.eq_ignore_ascii_case("approve") {
                    Some(Endpoint::Approve)
                } else if action.eq_ignore_ascii_case("cancel") {
                    Some(Endpoint::Cancel)
                } else {
                    None
                }
            }
            _ => None,
        }
    } else if parts[2].eq_ignore_ascii_case("me") && parts.len() == 3 {
        Some(Endpoint::Me)
    } else if parts[2].eq_ignore_ascii_case("revoke-current") && parts.len() == 3 {
        Some(Endpoint::RevokeCurrent)
    } else {
        None
    }
}

pub(super) fn reserved_path(path: &str) -> bool {
    let decoded = decoded_path(path);
    let mut parts = decoded.split('/').filter(|part| !part.is_empty());
    parts
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case("api"))
        && parts
            .next()
            .is_some_and(|part| part.eq_ignore_ascii_case("cli-auth"))
}

fn decoded_path(path: &str) -> String {
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
    decoded
}

pub(super) async fn handle(
    state: web::Data<super::IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    endpoint: Endpoint,
) -> HttpResponse {
    if let Some(response) = super::private_host_rejection(&state, &request) {
        return no_store(response);
    }
    if !method_matches(endpoint, request.method()) {
        return no_store(not_found(&state));
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return no_store(
                state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full"),
            );
        }
    };
    let body = match read_body(&mut payload).await {
        Ok(body) => body,
        Err(response) => return no_store(response),
    };
    let json_body = match parse_json_body(&request, &body) {
        Ok(body) => body,
        Err(ParseBodyError::InvalidJson) => {
            return no_store(HttpResponse::BadRequest().json(json!({
                "message": "Invalid JSON in request body",
                "code": "BAD_REQUEST"
            })));
        }
    };
    let challenge_id = match endpoint_id(endpoint, &request) {
        Some(challenge_id) => challenge_id,
        None if matches!(
            endpoint,
            Endpoint::Poll | Endpoint::Approve | Endpoint::Cancel
        ) =>
        {
            return no_store(not_found(&state));
        }
        None => String::new(),
    };

    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return no_store(
            state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled"),
        );
    };
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(_) => return no_store(unavailable(&state)),
    };
    let actor = match authenticate_optional(&state, &request, &mut transaction).await {
        Ok(actor) => actor,
        Err(response) => return no_store(response),
    };

    let response = match endpoint {
        Endpoint::Create => create(&state, &request, &mut transaction, json_body).await,
        Endpoint::Poll => {
            poll(
                &state,
                &request,
                &mut transaction,
                actor.as_ref(),
                &challenge_id,
            )
            .await
        }
        Endpoint::Approve => {
            approve(
                &state,
                &request,
                &mut transaction,
                actor.as_ref(),
                &challenge_id,
                json_body,
            )
            .await
        }
        Endpoint::Cancel => cancel(&state, &mut transaction, &challenge_id, json_body).await,
        Endpoint::Me => me(&state, &mut transaction, actor.as_ref()).await,
        Endpoint::RevokeCurrent => {
            revoke_current(&state, &request, &mut transaction, actor.as_ref()).await
        }
    };
    match response {
        Ok(response) => match transaction.commit().await {
            Ok(()) => no_store(response),
            Err(_) => no_store(unavailable(&state)),
        },
        Err(response) => no_store(response),
    }
}

fn endpoint_id(endpoint: Endpoint, request: &HttpRequest) -> Option<String> {
    if !matches!(
        endpoint,
        Endpoint::Poll | Endpoint::Approve | Endpoint::Cancel
    ) {
        return Some(String::new());
    }
    let parts: Vec<_> = decoded_path(request.uri().path())
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    let id = parts.get(3)?.trim();
    uuid::Uuid::parse_str(id).ok().map(|_| id.to_owned())
}

fn method_matches(endpoint: Endpoint, method: &Method) -> bool {
    match endpoint {
        Endpoint::Create | Endpoint::Approve | Endpoint::Cancel | Endpoint::RevokeCurrent => {
            method == Method::POST
        }
        Endpoint::Poll | Endpoint::Me => matches!(*method, Method::GET | Method::HEAD),
    }
}

async fn read_body(payload: &mut web::Payload) -> Result<Vec<u8>, HttpResponse> {
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|_| {
            HttpResponse::BadRequest().json(json!({
                "message": "Invalid JSON in request body",
                "code": "BAD_REQUEST"
            }))
        })?;
        if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err(HttpResponse::PayloadTooLarge().json(json!({
                "message": "Payload too large",
                "code": "PAYLOAD_TOO_LARGE"
            })));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

enum ParseBodyError {
    InvalidJson,
}

fn parse_json_body(request: &HttpRequest, body: &[u8]) -> Result<Option<Value>, ParseBodyError> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("application/json")
        || body.is_empty()
    {
        return Ok(None);
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(value) if value.is_object() || value.is_array() => Ok(Some(value)),
        _ => Err(ParseBodyError::InvalidJson),
    }
}

async fn authenticate_optional(
    state: &super::IngressState,
    request: &HttpRequest,
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Option<CliActor>, HttpResponse> {
    let Some(config) = state.cli_auth_browser_auth.as_ref() else {
        return Ok(None);
    };
    match browser_auth::authenticate(config, request, transaction, None).await {
        Ok(actor) => Ok(Some(actor.into())),
        Err(BrowserAuthError::Unauthorized | BrowserAuthError::Forbidden)
            if config.is_local_implicit() =>
        {
            // Express initializes local-trusted requests as the loopback Board
            // actor and leaves that actor in place when a supplied bearer does
            // not resolve to a stored key.
            Ok(Some(CliActor {
                user_id: "local-board".to_owned(),
                source: "local_implicit".to_owned(),
                session_id: "local-implicit".to_owned(),
            }))
        }
        Err(BrowserAuthError::Unauthorized | BrowserAuthError::Forbidden) => Ok(None),
        Err(BrowserAuthError::Unavailable) => Err(unavailable_response(state)),
    }
}

async fn create(
    state: &super::IngressState,
    request: &HttpRequest,
    transaction: &mut Transaction<'_, Postgres>,
    body: Option<Value>,
) -> Result<HttpResponse, HttpResponse> {
    let input: CreateChallengeInput = match body {
        Some(body) => serde_json::from_value(body).map_err(|_| validation_error())?,
        None => return Err(validation_error()),
    };
    if input.command.is_empty()
        || utf16_len(&input.command) > 240
        || input
            .client_name
            .as_ref()
            .is_some_and(|name| utf16_len(name) > 120)
        || !matches!(
            input.requested_access.as_str(),
            "board" | "instance_admin_required"
        )
    {
        return Err(validation_error());
    }
    let requested_company_id = input.requested_company_id.as_deref();
    if requested_company_id.is_some_and(|value| uuid::Uuid::parse_str(value).is_err()) {
        return Err(validation_error());
    }
    let command = input.command.trim();
    let client_name = input
        .client_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let label_base = client_name.unwrap_or("rudder cli");
    let pending_key_name = if input.requested_access == "instance_admin_required" {
        format!("{label_base} (instance admin)")
    } else {
        format!("{label_base} (board)")
    };
    let challenge_secret =
        random_secret("pcp_cli_auth_").map_err(|_| unavailable_response(state))?;
    let pending_board_token =
        random_secret("pcp_board_").map_err(|_| unavailable_response(state))?;
    let challenge_secret_hash = crate::native_bearer_auth::hash_token(&challenge_secret);
    let pending_key_hash = crate::native_bearer_auth::hash_token(&pending_board_token);
    let challenge = persistence::NewChallenge {
        secret_hash: &challenge_secret_hash,
        command,
        client_name,
        requested_access: &input.requested_access,
        requested_company_id,
        pending_key_hash: &pending_key_hash,
        pending_key_name: &pending_key_name,
    };
    let created = persistence::create_challenge(transaction, challenge)
        .await
        .map_err(|_| unavailable_response(state))?;
    let approval_path = format!(
        "/cli-auth/{}?token={}",
        created.id,
        url::form_urlencoded::byte_serialize(challenge_secret.as_bytes()).collect::<String>()
    );
    let identity = state.config.forwarding_policy.identity(request).ok();
    let scheme = identity.map(|identity| identity.scheme).unwrap_or("http");
    let host = state.config.forwarding_policy.authority(request);
    let approval_url = host.map(|host| format!("{scheme}://{host}{approval_path}"));
    Ok(HttpResponse::Created().json(json!({
        "id": created.id,
        "token": challenge_secret,
        "boardApiToken": pending_board_token,
        "approvalPath": approval_path,
        "approvalUrl": approval_url,
        "pollPath": format!("/cli-auth/challenges/{}", created.id),
        "expiresAt": created.expires_at,
        "suggestedPollIntervalMs": 1000,
    })))
}

async fn poll(
    state: &super::IngressState,
    request: &HttpRequest,
    transaction: &mut Transaction<'_, Postgres>,
    actor: Option<&CliActor>,
    id: &str,
) -> Result<HttpResponse, HttpResponse> {
    let Some(token) = query_token(request.query_string()) else {
        return Err(challenge_not_found(state));
    };
    let Some(challenge) = persistence::describe_challenge(
        transaction,
        id,
        &crate::native_bearer_auth::hash_token(token.trim()),
    )
    .await
    .map_err(|_| unavailable_response(state))?
    else {
        return Err(challenge_not_found(state));
    };
    let requested_access = challenge
        .get("requestedAccess")
        .and_then(Value::as_str)
        .unwrap_or("board");
    let mut can_approve = false;
    if let Some(actor) = actor {
        let signed_in = actor.source == "session" || actor.source == "local_implicit";
        if signed_in {
            let access = persistence::board_access(transaction, &actor.user_id)
                .await
                .map_err(|_| unavailable_response(state))?;
            can_approve = requested_access != "instance_admin_required"
                || access.is_instance_admin
                || actor.source == "local_implicit";
        }
    }
    let current_user_id = actor
        .filter(|actor| actor.source != "agent_key")
        .map(|actor| actor.user_id.clone());
    let mut result = challenge.as_object().cloned().unwrap_or_default();
    result.insert(
        "requiresSignIn".to_owned(),
        json!(actor.is_none_or(|actor| actor.source == "agent_key")),
    );
    result.insert("canApprove".to_owned(), json!(can_approve));
    result.insert("currentUserId".to_owned(), json!(current_user_id));
    Ok(HttpResponse::Ok().json(Value::Object(result)))
}

async fn approve(
    state: &super::IngressState,
    request: &HttpRequest,
    transaction: &mut Transaction<'_, Postgres>,
    actor: Option<&CliActor>,
    id: &str,
    body: Option<Value>,
) -> Result<HttpResponse, HttpResponse> {
    let Some(actor) = actor else {
        return Err(http_error(
            StatusCode::UNAUTHORIZED,
            "Sign in before approving CLI access",
        ));
    };
    if actor.source == "session" && !is_trusted_browser_mutation(request) {
        return Err(http_error(
            StatusCode::FORBIDDEN,
            "Board mutation requires trusted browser origin",
        ));
    }
    let input: ResolveChallengeInput = match body {
        Some(body) => serde_json::from_value(body).map_err(|_| validation_error())?,
        None => return Err(validation_error()),
    };
    if !(16..=256).contains(&utf16_len(&input.token)) {
        return Err(validation_error());
    }
    let access = persistence::board_access(transaction, &actor.user_id)
        .await
        .map_err(|_| unavailable_response(state))?;
    let approved = persistence::approve_challenge(
        transaction,
        id,
        &crate::native_bearer_auth::hash_token(&input.token),
        &actor.user_id,
        access.is_instance_admin,
    )
    .await
    .map_err(|error| match error {
        persistence::ApproveError::InstanceAdminRequired => {
            http_error(StatusCode::FORBIDDEN, "Instance admin required")
        }
        persistence::ApproveError::Database => unavailable_response(state),
    })?
    .ok_or_else(|| challenge_not_found(state))?;
    if approved.newly_approved {
        let org_ids =
            persistence::activity_org_ids(transaction, &actor.user_id, access.is_instance_admin)
                .await
                .map_err(|_| unavailable_response(state))?;
        persistence::record_activity(
            transaction,
            &org_ids,
            &actor.user_id,
            "board_api_key.created",
            json!({
                "boardApiKeyId": approved.key_id,
                "requestedAccess": approved.requested_access,
                "requestedCompanyId": approved.requested_company_id,
                "challengeId": id,
            }),
        )
        .await
        .map_err(|_| unavailable_response(state))?;
    }
    if approved.status == "approved" && approved.approved_by_user_id.is_none() {
        return Err(unavailable_response(state));
    }
    let response_user_id = if approved.status == "approved" {
        approved.approved_by_user_id.as_deref()
    } else {
        Some(actor.user_id.as_str())
    };
    Ok(HttpResponse::Ok().json(json!({
        "approved": approved.status == "approved",
        "status": approved.status,
        "userId": response_user_id,
        "keyId": approved.key_id,
        "expiresAt": approved.expires_at,
    })))
}

async fn cancel(
    state: &super::IngressState,
    transaction: &mut Transaction<'_, Postgres>,
    id: &str,
    body: Option<Value>,
) -> Result<HttpResponse, HttpResponse> {
    let input: ResolveChallengeInput = match body {
        Some(body) => serde_json::from_value(body).map_err(|_| validation_error())?,
        None => return Err(validation_error()),
    };
    if !(16..=256).contains(&utf16_len(&input.token)) {
        return Err(validation_error());
    }
    let status = persistence::cancel_challenge(
        transaction,
        id,
        &crate::native_bearer_auth::hash_token(&input.token),
    )
    .await
    .map_err(|_| unavailable_response(state))?
    .ok_or_else(|| challenge_not_found(state))?;
    Ok(HttpResponse::Ok().json(json!({
        "status": status,
        "cancelled": status == "cancelled",
    })))
}

async fn me(
    state: &super::IngressState,
    transaction: &mut Transaction<'_, Postgres>,
    actor: Option<&CliActor>,
) -> Result<HttpResponse, HttpResponse> {
    let Some(actor) = actor else {
        return Err(http_error(
            StatusCode::UNAUTHORIZED,
            "Board authentication required",
        ));
    };
    let access = persistence::board_access(transaction, &actor.user_id)
        .await
        .map_err(|_| unavailable_response(state))?;
    let key_id = if actor.source == "board_key" {
        actor.session_id.strip_prefix("board-key:")
    } else {
        None
    };
    Ok(HttpResponse::Ok().json(json!({
        "user": access.user,
        "userId": actor.user_id,
        "isInstanceAdmin": access.is_instance_admin || actor.source == "local_implicit",
        "orgIds": access.org_ids,
        "source": actor.source,
        "keyId": key_id,
    })))
}

async fn revoke_current(
    state: &super::IngressState,
    request: &HttpRequest,
    transaction: &mut Transaction<'_, Postgres>,
    actor: Option<&CliActor>,
) -> Result<HttpResponse, HttpResponse> {
    let Some(actor) = actor.filter(|actor| actor.source == "board_key") else {
        return Err(http_error(
            StatusCode::BAD_REQUEST,
            "Current board API key context is required",
        ));
    };
    let Some(key_id) = actor.session_id.strip_prefix("board-key:") else {
        return Err(challenge_not_found(state));
    };
    let Some(token) = bearer_token(request) else {
        return Err(http_error(
            StatusCode::BAD_REQUEST,
            "Current board API key context is required",
        ));
    };
    let key_hash = crate::native_bearer_auth::hash_token(token);
    let Some(revoked_key_id) =
        persistence::revoke_key(transaction, &actor.user_id, key_id, &key_hash)
            .await
            .map_err(|_| unavailable_response(state))?
    else {
        return Err(challenge_not_found(state));
    };
    let access = persistence::board_access(transaction, &actor.user_id)
        .await
        .map_err(|_| unavailable_response(state))?;
    let org_ids =
        persistence::activity_org_ids(transaction, &actor.user_id, access.is_instance_admin)
            .await
            .map_err(|_| unavailable_response(state))?;
    persistence::record_activity(
        transaction,
        &org_ids,
        &actor.user_id,
        "board_api_key.revoked",
        json!({
            "boardApiKeyId": revoked_key_id,
            "revokedVia": "cli_auth_logout",
        }),
    )
    .await
    .map_err(|_| unavailable_response(state))?;
    Ok(HttpResponse::Ok().json(json!({
        "revoked": true,
        "keyId": revoked_key_id,
    })))
}

fn bearer_token(request: &HttpRequest) -> Option<&str> {
    let mut headers = request.headers().get_all(header::AUTHORIZATION);
    let value = headers.next()?;
    if headers.next().is_some() {
        return None;
    }
    let value = value.to_str().ok()?;
    value
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case("bearer "))?;
    Some(value[7..].trim())
}

fn query_token(query: &str) -> Option<String> {
    let mut token = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if key == "token" {
            if token.is_some() {
                return None;
            }
            token = Some(value.into_owned());
        }
    }
    token.filter(|token| !token.trim().is_empty())
}

fn random_secret(prefix: &str) -> Result<String, ()> {
    let mut bytes = [0_u8; 24];
    SystemRandom::new().fill(&mut bytes).map_err(|_| ())?;
    let mut token = String::with_capacity(prefix.len() + bytes.len() * 2);
    token.push_str(prefix);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn validation_error() -> HttpResponse {
    http_error(StatusCode::BAD_REQUEST, "Validation error")
}

fn challenge_not_found(_state: &super::IngressState) -> HttpResponse {
    http_error(StatusCode::NOT_FOUND, "CLI auth challenge not found")
}

fn unavailable_response(_state: &super::IngressState) -> HttpResponse {
    http_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Service temporarily unavailable",
    )
}

fn unavailable(state: &super::IngressState) -> HttpResponse {
    unavailable_response(state)
}

fn not_found(_state: &super::IngressState) -> HttpResponse {
    http_error(StatusCode::NOT_FOUND, "API route not found")
}

pub(super) fn reserved_not_found(state: &super::IngressState) -> HttpResponse {
    no_store(not_found(state))
}

fn no_store(mut response: HttpResponse) -> HttpResponse {
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(NO_STORE),
    );
    headers.insert(header::PRAGMA, header::HeaderValue::from_static("no-cache"));
    headers.insert(header::EXPIRES, header::HeaderValue::from_static("0"));
    response
}

fn http_error(status: StatusCode, message: &'static str) -> HttpResponse {
    HttpResponse::build(status).json(json!({ "error": message }))
}

/// Match the existing Node board-mutation guard: browser sessions require an
/// Origin or Referer derived from the request Host (or the two dev origins),
/// while bearer-key and local-implicit actors do not rely on browser cookies.
fn is_trusted_browser_mutation(request: &HttpRequest) -> bool {
    let mut allowed = [
        "http://localhost:3100".to_owned(),
        "http://127.0.0.1:3100".to_owned(),
    ]
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    if let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|host| !host.is_empty())
    {
        allowed.insert(format!("http://{host}").to_ascii_lowercase());
        allowed.insert(format!("https://{host}").to_ascii_lowercase());
    }
    [header::ORIGIN, header::REFERER]
        .into_iter()
        .filter_map(|name| request.headers().get(name)?.to_str().ok())
        .filter_map(|value| Url::parse(value).ok())
        .map(|url| url.origin().ascii_serialization().to_ascii_lowercase())
        .any(|origin| allowed.contains(&origin))
}

#[cfg(test)]
mod tests;
