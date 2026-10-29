//! Public managed-MCP transport; the native runtime owns all binding policy,
//! credentials, upstream execution and audit. Only verified signed Run actors
//! can enter this endpoint.
use super::*;
use crate::{managed_mcp_runtime, native_session_auth::NativeIngressIdentity};
use futures_util::StreamExt;
use std::sync::Arc;

pub(super) fn binding_reference(request: &HttpRequest) -> Option<String> {
    if *request.method() != Method::POST {
        return None;
    }
    let path = request.uri().path().strip_prefix('/')?;
    let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    if parts.len() != 5
        || !parts[0].eq_ignore_ascii_case("api")
        || !parts[1].eq_ignore_ascii_case("mcp")
        || !parts[2].eq_ignore_ascii_case("runtime")
        || !parts[3].eq_ignore_ascii_case("bindings")
    {
        return None;
    }
    percent_encoding::percent_decode_str(parts[4])
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
        .filter(|value| !value.is_empty())
}

pub(super) async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    binding: String,
    host: Arc<managed_mcp_runtime::Host>,
) -> HttpResponse {
    let mut bytes = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "invalid_request_body");
        };
        if bytes.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return state
                .foundation
                .json_error(StatusCode::PAYLOAD_TOO_LARGE, "request_body_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &bytes) {
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
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let NativeIngressIdentity::AgentJwt(identity) = identity else {
        return HttpResponse::Forbidden()
            .json(serde_json::json!({"error":"Signed agent run authentication required"}));
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "managed_mcp_unavailable");
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    let identity = rudder_d1_persistence::managed_mcp_runtime::Identity {
        organization_id: identity.org_id,
        agent_id: identity.agent_id,
        run_id: identity.run_id,
    };
    let reply = managed_mcp_runtime::handle(
        pool,
        &identity,
        &binding,
        &body,
        request
            .headers()
            .get("MCP-Protocol-Version")
            .and_then(|value| value.to_str().ok()),
        &host,
    )
    .await;
    let mut response = HttpResponse::build(
        StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
    );
    for (name, value) in reply.headers {
        response.insert_header((name, value));
    }
    match reply.body {
        Some(body) => response.json(body),
        None => response.finish(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_route_preserves_case_capture_and_excludes_other_mcp_routes() {
        for path in [
            "/api/mcp/runtime/bindings/a",
            "/API/MCP/RUNTIME/BINDINGS/%61/",
        ] {
            let request = actix_web::test::TestRequest::post()
                .uri(path)
                .to_http_request();
            assert_eq!(binding_reference(&request).as_deref(), Some("a"));
        }
        for path in [
            "/api/mcp/runtime/bindings",
            "/api/mcp/runtime/bindings//",
            "/api/mcp/runtime/bindings/a/extra",
            "/api/mcp/oauth/callback",
        ] {
            let request = actix_web::test::TestRequest::post()
                .uri(path)
                .to_http_request();
            assert_eq!(binding_reference(&request), None);
        }
    }
}
