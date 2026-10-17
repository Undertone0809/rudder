//! The existing UI session DTO backed by native credential verification.
use super::*;
use crate::browser_auth::{BrowserAuthError, authenticate};

pub(super) fn reserved_path(path: &str) -> bool {
    let mut decoded = path.to_owned();
    // Reserve common nested-encoding aliases as well as Express case/slash
    // variants; do not let the compatibility router reinterpret them.
    for _ in 0..4 {
        let next = percent_encoding::percent_decode_str(&decoded)
            .decode_utf8_lossy()
            .into_owned();
        if next == decoded {
            break;
        }
        decoded = next;
    }
    let parts: Vec<_> = decoded.split('/').filter(|part| !part.is_empty()).collect();
    parts.len() >= 3
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("auth")
        && parts[2].eq_ignore_ascii_case("get-session")
}

pub(super) async fn get(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
) -> HttpResponse {
    let mut response = resolve(state, request, body).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

async fn resolve(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
) -> HttpResponse {
    if request.uri().path() != "/api/auth/get-session" {
        return state
            .foundation
            .json_error(StatusCode::NOT_FOUND, "route_not_found");
    }
    if !body.is_empty() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "session_read_body_not_allowed");
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let Some(config) = &state.config.browser_auth else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_browser_auth_not_configured",
        );
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let mut connection = match pool.acquire().await {
        Ok(connection) => connection,
        Err(_) => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "authentication_unavailable",
            );
        }
    };
    match authenticate(config, &request, &mut connection, None).await {
        Ok(actor) => HttpResponse::Ok()
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .json(actor.public_session()),
        Err(BrowserAuthError::Unauthorized) => state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "Unauthorized"),
        Err(BrowserAuthError::Forbidden) => state
            .foundation
            .json_error(StatusCode::FORBIDDEN, "Forbidden"),
        Err(BrowserAuthError::Unavailable) => state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "authentication_unavailable",
        ),
    }
}
