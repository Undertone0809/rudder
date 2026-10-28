//! Public Assistance Request writes. Native identity and signed intent stay in
//! Rust; the D1 transaction owns locks, revalidation, audit and native wakeup.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use futures_util::StreamExt;
use rudder_d1_persistence::request_writes::{
    self, REQUEST_WRITE_SCOPE, RequestWriteError, RequestWriteOperation,
};
use serde_json::json;
use uuid::Uuid;

fn endpoint(path: &str, method: &Method) -> Option<(String, RequestWriteOperation)> {
    if *method != Method::POST {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    match parts.as_slice() {
        [api, requests, id, action]
            if api.eq_ignore_ascii_case("api")
                && requests.eq_ignore_ascii_case("requests")
                && !id.is_empty() =>
        {
            let operation = if action.eq_ignore_ascii_case("resolve") {
                RequestWriteOperation::Resolve
            } else if action.eq_ignore_ascii_case("cancel") {
                RequestWriteOperation::Cancel
            } else {
                return None;
            };
            // Keep invalid captures reserved so they cannot fall back to Node.
            Some(((*id).into(), operation))
        }
        _ => None,
    }
}
pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint(path, method).is_some()
}
pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some((id, operation)) = endpoint(request.path(), request.method()) else {
        return HttpResponse::NotFound().json(json!({"error":"Request route not found"}));
    };
    let id = match percent_encoding::percent_decode_str(&id).decode_utf8() {
        Ok(id) => id.into_owned(),
        Err(_) => return HttpResponse::BadRequest().json(json!({"error":"Invalid request path"})),
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return HttpResponse::PayloadTooLarge()
                .json(json!({"error":"Request body is too large"}));
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
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    // Express only parses application/json with a body framing header. Other
    // requests leave req.body undefined, which Zod reports at the object root.
    let is_json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    let has_body = request.headers().contains_key(header::CONTENT_LENGTH)
        || request.headers().contains_key(header::TRANSFER_ENCODING);
    if !is_json || (!has_body && body.is_empty()) {
        return HttpResponse::BadRequest().json(json!({"error":"Validation error","details":[{"code":"invalid_type","expected":"object","received":"undefined","path":[],"message":"Required"}]}));
    }
    let input = if body.is_empty() {
        json!({})
    } else {
        match std::str::from_utf8(&body)
            .ok()
            .and_then(|body| rudder_d1_persistence::agent_core::parse_public_json_value(body).ok())
        {
            Some(value) => value,
            None => {
                return HttpResponse::InternalServerError()
                    .json(json!({"error":"Internal server error"}));
            }
        }
    };
    let input = match request_writes::validate_input(operation, &input) {
        Ok(input) => input,
        Err(error) => return response_error(error),
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, reason)) => return state.foundation.json_error(status, reason),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return HttpResponse::Forbidden()
            .json(json!({"error":crate::local_account_ingress::BOARD_ORIGIN_ERROR}));
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
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
    let Some(key) = state.foundation.config.actor_envelope_key.as_ref() else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "actor_envelope_unconfigured",
        );
    };
    let signed_body =
        serde_json::to_vec(&json!({"requestId":id,"input":input})).expect("JSON values serialize");
    let target = request.uri().to_string();
    let request_id = Uuid::new_v4().to_string();
    let now = unix_time_seconds();
    let verified = ActorEnvelope::new(
        actor.clone(),
        REQUEST_WRITE_SCOPE,
        session_id.clone(),
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        request.method().as_str(),
        &target,
        operation.action(),
        &signed_body,
        &request_id,
        Uuid::new_v4().to_string(),
        now,
        now + 30,
    )
    .and_then(|envelope| envelope.sign_with_key(key))
    .ok()
    .and_then(|envelope| {
        state
            .foundation
            .verify_actor_envelope_parts(
                key,
                &envelope,
                &request,
                REQUEST_WRITE_SCOPE,
                operation.action(),
                None,
                &signed_body,
                &request_id,
            )
            .ok()
    });
    let Some(actor) = verified else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "actor_envelope_unavailable",
        );
    };
    match request_writes::execute(pool, &actor, &authorizer, &id, operation, &input).await {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(RequestWriteError::Http(403, message))
            if message == "User does not have access to this organization" =>
        {
            project_reads::forbidden_response(&identity)
        }
        Err(error) => response_error(error),
    }
}
fn response_error(error: RequestWriteError) -> HttpResponse {
    match error {
        RequestWriteError::Validation(details) => {
            HttpResponse::BadRequest().json(json!({"error":"Validation error","details":details}))
        }
        RequestWriteError::Http(status, message) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        RequestWriteError::Admission(
            rudder_d1_persistence::agent_execution::AgentExecutionError::Http(
                status,
                message,
                details,
            ),
        ) => {
            let mut value = json!({"error":message});
            if let Some(details) = details {
                value["details"] = details;
            }
            HttpResponse::build(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            )
            .json(value)
        }
        error => {
            tracing::warn!(error=?error,"native Assistance Request write failed");
            HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_write_shapes_and_express_aliases_remain_native() {
        for path in [
            "/api/requests/id/resolve",
            "/API/REQUESTS/id/CANCEL/",
            "/api/requests/%FF/resolve",
        ] {
            assert!(is_reserved_path(path, &Method::POST));
            assert!(!is_reserved_path(path, &Method::GET));
        }
        for path in [
            "/api/requests/id/resolve/extra",
            "/api/requests/id",
            "/api/requests//resolve",
        ] {
            assert!(!is_reserved_path(path, &Method::POST));
        }
    }
}
