//! Last public read paths whose query/artifact authority already lives in Rust.
//! Public identity and scope are native; existing readers retain projection and
//! streaming ownership. Writes and mixed legacy Chat reads are outside this cut.
mod board;
mod live;
mod paths;
use super::*;
use crate::member_directory_auth::MemberDirectoryNativeAccess;
use futures_util::StreamExt;
use paths::Endpoint;
use serde_json::{Value, json};

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    paths::endpoint(path, method).is_some()
}

pub(super) async fn dispatch(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = paths::endpoint(request.uri().path(), request.method()) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return error(StatusCode::BAD_REQUEST, "Invalid request body");
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large");
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, reason)) => return state.foundation.json_error(status, reason),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Some(auth) = agent_core::native_authorizer(&identity, &actor, &session_id, &state) else {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let (org, issue) = match &endpoint {
        Endpoint::LiveIssue(reference) => match decode(reference) {
            Ok(reference) => match run_reads::resolve_issue_reference(pool, &reference).await {
                Ok(Some((id, org))) => (org, Some(id)),
                Ok(None) => return error(StatusCode::NOT_FOUND, "Issue not found"),
                Err(_) => return internal_error(),
            },
            Err(response) => return response,
        },
        Endpoint::LiveOrg(org) | Endpoint::Board(org, _) => match decode(org) {
            Ok(org) => (org, None),
            Err(response) => return response,
        },
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return internal_error();
    }
    match auth.revalidate(&mut tx, &org).await {
        Ok(MemberDirectoryNativeAccess::Authorized) => (),
        Ok(MemberDirectoryNativeAccess::Unauthorized) => {
            return error(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
        Ok(MemberDirectoryNativeAccess::Forbidden) => {
            return project_reads::forbidden_response(&identity);
        }
        Err(_) => return internal_error(),
    }
    if tx.commit().await.is_err() {
        return internal_error();
    }
    let owner = match crate::run_reads::native_run_owner(&identity) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    match endpoint {
        Endpoint::LiveOrg(_) | Endpoint::LiveIssue(_) => {
            live::read(pool, &org, issue, owner, &request).await
        }
        Endpoint::Board(_, read) => {
            let Some(user) = owner else {
                return error(StatusCode::FORBIDDEN, "Board access required");
            };
            board::read(&state, &org, user, read, &request).await
        }
    }
}
#[allow(clippy::result_large_err)]
fn decode(raw: &str) -> Result<String, HttpResponse> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid request path"))
}
fn query(request: &HttpRequest) -> std::collections::HashMap<String, Value> {
    let mut query = std::collections::HashMap::new();
    for (key, value) in url::form_urlencoded::parse(request.query_string().as_bytes()) {
        query
            .entry(key.into_owned())
            .and_modify(|old| match old {
                Value::Array(values) => values.push(json!(value)),
                old => *old = json!([old.clone(), value]),
            })
            .or_insert_with(|| json!(value));
    }
    query
}
fn error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status).json(json!({"error":message}))
}
fn internal_error() -> HttpResponse {
    error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
