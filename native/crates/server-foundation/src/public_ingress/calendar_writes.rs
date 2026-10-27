//! Six local Calendar source/event writes over the public native listener.
//! Existing D1 validators, policy, SQL and atomic receipts remain authoritative.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::calendar::{CalendarError, execute_calendar_for_actor};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Endpoint {
    organization_id: String,
    id: Option<String>,
    operation: &'static str,
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path, method).is_some()
}
fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    if parts.iter().any(|part| part.is_empty())
        || !(parts.len() == 5 || parts.len() == 6)
        || !parts[0].eq_ignore_ascii_case("api")
        || !parts[1].eq_ignore_ascii_case("orgs")
        || !parts[3].eq_ignore_ascii_case("calendar")
    {
        return None;
    }
    let operation = match (
        parts[4].to_ascii_lowercase().as_str(),
        parts.len(),
        method.as_str(),
    ) {
        ("sources", 5, "POST") => "source.create",
        ("sources", 6, "PATCH") => "source.update",
        ("sources", 6, "DELETE") => "source.delete",
        ("events", 5, "POST") => "event.create",
        ("events", 6, "PATCH") => "event.update",
        ("events", 6, "DELETE") => "event.delete",
        _ => return None,
    };
    let decode = |raw: &str| {
        percent_encoding::percent_decode_str(raw)
            .decode_utf8_lossy()
            .into_owned()
    };
    Some(Endpoint {
        organization_id: decode(parts[2]),
        id: parts.get(5).map(|id| decode(id)),
        operation,
    })
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return error(404, "Calendar route not found");
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return error(400, "Invalid request body");
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return error(413, "Request body too large");
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
    if state.config.identity_auth.is_none() {
        return error(503, "Rust Calendar is unavailable");
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return error(403, "Board access required");
    };
    if actor.kind != "user" {
        return error(403, "Board access required");
    }
    if matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return error(403, crate::local_account_ingress::BOARD_ORIGIN_ERROR);
    }
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return error(401, "Unauthorized");
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
        return error(503, "Rust Calendar is unavailable");
    };
    // The legacy adapters pass req.body unchanged into D1. No JSON body is
    // represented as null here, which the existing validator rejects after
    // authorization just like an absent private-command input.
    let input = if !body.is_empty()
        && request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            }) {
        match serde_json::from_slice::<Value>(&body) {
            Ok(value) => value,
            Err(_) => return error(500, "Internal server error"),
        }
    } else {
        Value::Null
    };
    let mut command = json!({"operation":endpoint.operation});
    if let Some(id) = endpoint.id {
        command["id"] = Value::String(id);
    }
    if !endpoint.operation.ends_with(".delete") {
        command["input"] = input;
    }
    let run_id = agent_run_id_header(&request);
    match execute_calendar_for_actor(
        pool,
        &endpoint.organization_id,
        &actor.id,
        run_id.as_deref(),
        &command,
        &authorizer,
    )
    .await
    {
        Ok((status, value)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(value),
        Err(CalendarError::Http(status, message)) => error(status, &message),
        Err(CalendarError::Database(_)) => error(500, "Internal server error"),
    }
}
fn error(status: u16, message: &str) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(json!({"error":message}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_exactly_the_six_local_mutations_with_express_aliases() {
        for (path, method, operation) in [
            (
                "/api/orgs/o/calendar/sources",
                Method::POST,
                "source.create",
            ),
            (
                "/API/ORGS/o/CALENDAR/SOURCES/s/",
                Method::PATCH,
                "source.update",
            ),
            (
                "/api/orgs/o/calendar/sources/s",
                Method::DELETE,
                "source.delete",
            ),
            ("/api/orgs/o/calendar/events", Method::POST, "event.create"),
            (
                "/api/orgs/o/calendar/events/e",
                Method::PATCH,
                "event.update",
            ),
            (
                "/api/orgs/o/calendar/events/e/",
                Method::DELETE,
                "event.delete",
            ),
        ] {
            let endpoint = endpoint_for_path(path, &method).unwrap();
            assert_eq!(endpoint.operation, operation);
            assert_eq!(endpoint.organization_id, "o");
        }
        for (path, method) in [
            ("/api/orgs/o/calendar/sources", Method::GET),
            ("/api/orgs/o/calendar/events", Method::GET),
            ("/api/orgs/o/calendar/events/e", Method::HEAD),
            ("/api/orgs/o/calendar/google/connect", Method::POST),
            ("/api/orgs/o/calendar/google/config", Method::PATCH),
            ("/api/orgs/o/calendar/google/sync", Method::POST),
        ] {
            assert!(!is_reserved_path(path, &method));
        }
    }
}
#[cfg(test)]
#[path = "calendar_writes/http_tests.rs"]
mod http_tests;
