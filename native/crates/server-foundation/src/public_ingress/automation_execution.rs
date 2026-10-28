//! Remaining Automation execution ingress. Public webhook authentication uses
//! its scoped trigger secret; manual/API admission uses native actor authority.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use futures_util::StreamExt;
use rudder_d1_persistence::{automation_execution as domain, automation_management::Actor};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Endpoint {
    Manual(String),
    PublicFire(String),
}
fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    if *method != Method::POST {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let segments = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    let decode = |raw: &str| {
        percent_encoding::percent_decode_str(raw)
            .decode_utf8_lossy()
            .into_owned()
    };
    match segments.as_slice() {
        [api, automations, id, run]
            if api.eq_ignore_ascii_case("api")
                && automations.eq_ignore_ascii_case("automations")
                && run.eq_ignore_ascii_case("run")
                && !id.is_empty() =>
        {
            Some(Endpoint::Manual(decode(id)))
        }
        [api, triggers, public, id, fire]
            if api.eq_ignore_ascii_case("api")
                && triggers.eq_ignore_ascii_case("automation-triggers")
                && public.eq_ignore_ascii_case("public")
                && fire.eq_ignore_ascii_case("fire")
                && !id.is_empty() =>
        {
            Some(Endpoint::PublicFire(decode(id)))
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
    let Some(endpoint) = endpoint(request.uri().path(), request.method()) else {
        return error(404, "Automation route not found");
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return error(400, "Invalid request body");
        };
        if bytes.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return error(413, "Request body too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &bytes) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if state.config.agent_run_host.is_none() {
        return error(503, "Rust Automation execution is unavailable");
    }
    if state.config.identity_auth.is_none() {
        return error(503, "Rust Automation execution is unavailable");
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let has_json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
        && !bytes.is_empty();
    let input = if has_json {
        match std::str::from_utf8(&bytes)
            .ok()
            .and_then(|v| rudder_d1_persistence::agent_core::parse_public_json_value(v).ok())
        {
            Some(v) => Some(v),
            None => return error(400, "Invalid request body"),
        }
    } else {
        None
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return error(503, "Rust Automation execution is unavailable");
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(v) => v,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let host = domain::Host {
        chat: state
            .config
            .native_chat_runtime
            .as_ref()
            .map(|runtime| &runtime.host),
    };
    let value = match endpoint {
        Endpoint::PublicFire(public_id) => {
            let header_value = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok());
            domain::fire_public(
                pool,
                &public_id,
                domain::PublicFireInput {
                    authorization: header_value("authorization"),
                    signature: header_value("x-rudder-signature"),
                    timestamp: header_value("x-rudder-timestamp"),
                    idempotency_key: header_value("idempotency-key"),
                    raw_body: if has_json { &bytes } else { b"{}" },
                    payload: input.as_ref().filter(|v| v.is_object() || v.is_array()),
                },
                &host,
            )
            .await
        }
        Endpoint::Manual(id) => {
            let Some(input) = input else {
                return HttpResponse::BadRequest().json(json!({"error":"Validation error","details":[{"code":"invalid_type","expected":"object","received":"undefined","path":[],"message":"Required"}]}));
            };
            if let Err(error) = domain::normalize_run_input(input.clone()) {
                return failure(error);
            }
            let identity = match resolve_public_http_identity(&state, &request).await {
                Ok(v) => v,
                Err((status, code)) => return state.foundation.json_error(status, code),
            };
            if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
                return response;
            }
            let Some((actor, session)) = agent_core::actor_and_session(&identity) else {
                return error(401, "Unauthorized");
            };
            if matches!(&identity, NativeIngressIdentity::Session(_))
                && !crate::local_account_ingress::has_trusted_board_origin(&request)
            {
                return error(403, crate::local_account_ingress::BOARD_ORIGIN_ERROR);
            }
            let Some(authorizer) =
                agent_core::native_authorizer(&identity, &actor, &session, &state)
            else {
                return error(401, "Unauthorized");
            };
            let run = match &identity {
                NativeIngressIdentity::AgentJwt(jwt) => Some(jwt.run_id.as_str()),
                _ => request
                    .headers()
                    .get("x-rudder-run-id")
                    .and_then(|v| v.to_str().ok()),
            };
            domain::run_manual(
                pool,
                &authorizer,
                Actor {
                    kind: &actor.kind,
                    id: &actor.id,
                    run_id: run,
                    local_implicit: matches!(&identity, NativeIngressIdentity::LocalImplicit),
                },
                &id,
                &input,
                &host,
            )
            .await
        }
    };
    match value {
        Ok(value) => HttpResponse::Accepted().json(value),
        Err(err) => failure(err),
    }
}
fn failure(err: domain::Error) -> HttpResponse {
    match err {
        domain::Error::Http(status, message) => error(status, &message),
        domain::Error::Secret(rudder_d1_persistence::secrets::SecretsError::Http(
            status,
            message,
        )) => error(status, &message),
        domain::Error::Validation(details) => {
            HttpResponse::BadRequest().json(json!({"error":"Validation error","details":details}))
        }
        domain::Error::Management(rudder_d1_persistence::automation_management::Error::Http(
            status,
            message,
        )) => error(status, &message),
        domain::Error::Management(
            rudder_d1_persistence::automation_management::Error::Validation(details),
        ) => HttpResponse::BadRequest().json(json!({"error":"Validation error","details":details})),
        _ => error(500, "Internal server error"),
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
    fn only_existing_execution_paths_are_reserved() {
        assert_eq!(
            endpoint("/api/automations/id/run", &Method::POST),
            Some(Endpoint::Manual("id".into()))
        );
        assert_eq!(
            endpoint("/api/automation-triggers/public/key/fire", &Method::POST),
            Some(Endpoint::PublicFire("key".into()))
        );
        for path in [
            "/api/automations/id/run/extra",
            "/api/automations/id/run//",
            "/api/automation-triggers/public/key/fire/extra",
            "/api/automation-triggers/key/fire",
        ] {
            assert!(!is_reserved_path(path, &Method::POST));
        }
        assert!(!is_reserved_path("/api/automations/id/run", &Method::GET));
    }
}

#[cfg(test)]
mod http_tests;
