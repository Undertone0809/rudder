//! Native credential adaptation for the existing organization event socket.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;

pub(super) fn reserved_path(path: &str) -> bool {
    path.strip_prefix("/api/orgs/")
        .and_then(|path| path.strip_suffix("/events/ws"))
        .is_some_and(|org| !org.is_empty() && !org.contains('/'))
}
pub(super) async fn upgrade(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let Some(auth) = state.config.identity_auth.as_ref() else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    };
    let token = crate::live_events::bearer_token(&request);
    let pending =
        if token.is_none() && crate::native_session_auth::has_session_cookie(request.headers()) {
            match state.foundation.session_revocation.begin_upgrade() {
                Ok(pending) => Some(pending),
                Err(_) => {
                    return state.foundation.json_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "websocket_session_revocation_capacity_exhausted",
                    );
                }
            }
        } else {
            None
        };
    let identity = if let Some(token) = token {
        match state
            .foundation
            .resolve_public_bearer(&token, None, &auth.agent_jwt)
            .await
        {
            native_bearer_auth::NativeBearerResolution::Authorized { proof_identity, .. } => {
                *proof_identity
            }
            native_bearer_auth::NativeBearerResolution::Forbidden => {
                return state
                    .foundation
                    .json_error(StatusCode::FORBIDDEN, "forbidden");
            }
            native_bearer_auth::NativeBearerResolution::DatabaseDisabled => {
                return state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
            }
            native_bearer_auth::NativeBearerResolution::Unavailable => {
                return state.foundation.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "native_identity_unavailable",
                );
            }
            native_bearer_auth::NativeBearerResolution::Unauthorized
            | native_bearer_auth::NativeBearerResolution::Compatibility => {
                return state
                    .foundation
                    .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
            }
        }
    } else {
        match resolve_public_http_identity(&state, &request).await {
            Ok(identity) => identity,
            Err((status, code)) => return state.foundation.json_error(status, code),
        }
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let revocation = match (pending, &identity) {
        (Some(pending), NativeIngressIdentity::Session(identity)) => {
            match pending.bind(&identity.user_id) {
                Ok(registration) => Some(registration),
                Err(SessionRevocationUpgradeError::RevokedDuringAuthorization) => {
                    return state
                        .foundation
                        .json_error(StatusCode::FORBIDDEN, "account_session_changed");
                }
                Err(_) => {
                    return state.foundation.json_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "websocket_session_revocation_history_exhausted",
                    );
                }
            }
        }
        _ => None,
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let kind = state
        .config
        .session_auth
        .as_ref()
        .map_or(NativeSessionAuthKind::BetterAuth, |settings| settings.kind);
    crate::live_events::upgrade(
        request,
        payload,
        state.foundation.live_event_publisher.clone(),
        pool.clone(),
        identity,
        kind,
        revocation,
    )
    .await
}
