//! Public label mutations, including Agent keys and transactional native auth.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use futures_util::StreamExt;
use rudder_d1_persistence::label_writes::{self as domain, Operation};
use serde_json::{Value, json};

struct Endpoint {
    operation: Operation,
    reference: String,
}
fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    if parts.iter().any(|s| s.is_empty()) || !parts.first()?.eq_ignore_ascii_case("api") {
        return None;
    }
    match parts.as_slice() {
        [_, orgs, id, labels]
            if orgs.eq_ignore_ascii_case("orgs")
                && labels.eq_ignore_ascii_case("labels")
                && *method == Method::POST =>
        {
            Some(Endpoint {
                operation: Operation::Create,
                reference: (*id).into(),
            })
        }
        [_, labels, id] if labels.eq_ignore_ascii_case("labels") => match *method {
            Method::PATCH => Some(Endpoint {
                operation: Operation::Update,
                reference: (*id).into(),
            }),
            Method::DELETE => Some(Endpoint {
                operation: Operation::Delete,
                reference: (*id).into(),
            }),
            _ => None,
        },
        _ => None,
    }
}
pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint(path, method).is_some()
}
pub(super) async fn handle(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint(request.uri().path(), request.method()) else {
        return response(404, "Label route not found");
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return response(400, "Invalid request body");
        };
        if bytes.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return response(413, "Request body too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &bytes) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    let input = if !bytes.is_empty()
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
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => Some(value),
            Err(_) => return response(400, "Invalid request body"),
        }
    } else {
        None
    };
    // Legacy Zod validation runs before the label lookup and org decision.
    if let Err(error) = domain::validate_public(input.as_ref(), endpoint.operation) {
        return domain_error(error);
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if state.config.identity_auth.is_none() {
        return response(503, "Rust labels are unavailable");
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return response(401, "Unauthorized");
    };
    if matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return response(403, crate::local_account_ingress::BOARD_ORIGIN_ERROR);
    }
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return response(401, "Unauthorized");
    };
    let reference = match percent_encoding::percent_decode_str(&endpoint.reference).decode_utf8() {
        Ok(value) => value.into_owned(),
        Err(_) => return response(400, "Invalid path parameter"),
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
        return response(503, "Rust labels are unavailable");
    };
    let org = if endpoint.operation == Operation::Create {
        reference.clone()
    } else {
        match domain::organization_for_label(pool, &reference).await {
            Ok(Some(org)) => org,
            Ok(None) => return response(404, "Label not found"),
            Err(error) => return domain_error(error),
        }
    };
    let audit = domain::Audit {
        actor_type: if actor.kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.id.clone(),
        run_id: match &identity {
            NativeIngressIdentity::AgentJwt(identity) => Some(identity.run_id.clone()),
            NativeIngressIdentity::AgentKey { .. } => agent_run_id_header(&request),
            _ => None,
        },
    };
    let write = domain::Write {
        org_id: &org,
        label_id: (endpoint.operation != Operation::Create).then_some(reference.as_str()),
        operation: endpoint.operation,
        body: input.as_ref(),
        audit: &audit,
        authorizer: &authorizer,
    };
    match domain::execute(pool, write).await {
        Ok((status, value)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(value),
        Err(error) => domain_error(error),
    }
}
fn response(status: u16, message: &str) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(json!({"error":message}))
}
fn domain_error(error: domain::Error) -> HttpResponse {
    match error {
        domain::Error::Http(status, message) => response(status, &message),
        domain::Error::Validation(issues) => {
            HttpResponse::BadRequest().json(json!({"error":"Validation error","details":issues}))
        }
        domain::Error::Database(_) | domain::Error::Json(_) => {
            response(500, "Internal server error")
        }
    }
}

#[cfg(test)]
mod http_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_three_writes_and_keeps_other_issue_and_read_routes_separate() {
        for (path, method) in [
            ("/api/orgs/o/labels", Method::POST),
            ("/API/LABELS/l/", Method::PATCH),
            ("/api/labels/l", Method::DELETE),
        ] {
            assert!(is_reserved_path(path, &method));
        }
        for (path, method) in [
            ("/api/orgs/o/labels", Method::GET),
            ("/api/labels/l", Method::GET),
            ("/api/issues/i/labels", Method::POST),
            ("/api/labels/l/extra", Method::DELETE),
        ] {
            assert!(!is_reserved_path(path, &method));
        }
        assert!(
            is_reserved_path("/api/labels/%ff", &Method::PATCH),
            "invalid native inputs never escape to a Node handler"
        );
    }
}
