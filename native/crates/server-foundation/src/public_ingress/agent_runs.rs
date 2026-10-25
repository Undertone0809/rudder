//! Direct public cancellation for Runs owned by the native Goal worker.
//!
//! Legacy and non-Goal Agent Run requests remain on the existing proxy route.
//! The caller checks the target with D1 before giving this module the body, so
//! this handler can never fall back to Node after a native Goal Run is chosen.

use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::goal_run_cancellation::{
    NativeGoalRunCancelError, NativeGoalRunCancelTarget, request_authorized_cancel,
};
use serde_json::json;

pub(super) fn cancellation_reference(request: &HttpRequest) -> Option<String> {
    if *request.method() != Method::POST {
        return None;
    }
    let path = request.uri().path().strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() != 4
        || !parts[0].eq_ignore_ascii_case("api")
        || !parts[1].eq_ignore_ascii_case("agent-runs")
        || !parts[3].eq_ignore_ascii_case("cancel")
    {
        return None;
    }
    percent_encoding::percent_decode_str(parts[2])
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
        .filter(|value| !value.is_empty())
}

pub(super) async fn cancel_native_goal_run(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    target: NativeGoalRunCancelTarget,
) -> HttpResponse {
    // Express's JSON parser runs before its route handlers. Preserve its
    // malformed-body precedence only after D1 has established this native
    // route; legacy requests keep their original untouched Payload.
    let max_bytes = state
        .foundation
        .config
        .max_request_bytes
        .min(10 * 1024 * 1024);
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return HttpResponse::PayloadTooLarge().json(json!({"error":"Request body too large"}));
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
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
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
    let permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_run_cancel_unavailable",
        );
    };

    // Keep admission held across the transaction and the response projection.
    let _permit = permit;
    if let Err(error) = request_authorized_cancel(
        pool,
        &authorizer,
        &target,
        actor.kind.as_str(),
        actor.id.as_str(),
    )
    .await
    {
        return cancel_error(&state, error);
    }
    let owner = (actor.kind == "user").then_some(actor.id.as_str());
    match crate::run_reads::agent_run_cancel_response(
        pool,
        &target.organization_id,
        &target.run_id,
        owner,
    )
    .await
    {
        Ok(Some(response)) => HttpResponse::Ok()
            .content_type("application/json; charset=utf-8")
            .body(response),
        Ok(None) => HttpResponse::NotFound().json(json!({"error":"Agent run not found"})),
        Err(error) => {
            tracing::warn!(error = %error, "native Agent Run cancellation projection failed");
            state
                .foundation
                .json_error(StatusCode::INTERNAL_SERVER_ERROR, "agent_run_cancel_failed")
        }
    }
}

fn cancel_error(state: &IngressState, error: NativeGoalRunCancelError) -> HttpResponse {
    match error {
        NativeGoalRunCancelError::NotFound => {
            HttpResponse::NotFound().json(json!({"error":"Agent run not found"}))
        }
        NativeGoalRunCancelError::Unauthorized => {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        }
        NativeGoalRunCancelError::Forbidden => {
            HttpResponse::Forbidden().json(json!({"error":"Forbidden"}))
        }
        NativeGoalRunCancelError::Database(error) => {
            tracing::warn!(error = %error, "native Agent Run cancellation failed");
            state
                .foundation
                .json_error(StatusCode::INTERNAL_SERVER_ERROR, "agent_run_cancel_failed")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    #[test]
    fn route_match_is_exact_and_keeps_non_cancel_paths_on_proxy() {
        for path in [
            "/api/agent-runs/abc/cancel",
            "/API/AGENT-RUNS/run_abcdef01/CANCEL/",
        ] {
            let request = TestRequest::post().uri(path).to_http_request();
            assert_eq!(
                cancellation_reference(&request).as_deref(),
                Some(path.trim_end_matches('/').rsplit('/').nth(1).unwrap())
            );
        }
        for (method, path) in [
            (Method::GET, "/api/agent-runs/abc/cancel"),
            (Method::POST, "/api/agent-runs/abc/retry"),
            (Method::POST, "/api/agent-runs/a/cancel/extra"),
            (Method::POST, "/api/agent-runs//cancel"),
        ] {
            let request = TestRequest::default()
                .method(method)
                .uri(path)
                .to_http_request();
            assert_eq!(cancellation_reference(&request), None, "{path}");
        }
        let encoded = TestRequest::post()
            .uri("/api/agent-runs/%72un_abcdef01/cancel")
            .to_http_request();
        assert_eq!(
            cancellation_reference(&encoded).as_deref(),
            Some("run_abcdef01")
        );
    }
}

#[cfg(test)]
mod http_tests;
