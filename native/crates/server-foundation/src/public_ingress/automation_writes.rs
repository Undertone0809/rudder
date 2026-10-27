//! Seven Automation management writes. Run/fire and the scheduler retain their
//! existing owner; selected writes have no Node callback or fallback.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::automation_management::{
    Actor, Command, Error, Operation, execute, normalize_input,
};
#[cfg(test)]
use serde_json::Value;
use serde_json::json;
#[derive(Clone, Debug, PartialEq, Eq)]
struct Endpoint {
    operation: Operation,
    organization_id: Option<String>,
    id: Option<String>,
}
fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let parts = path
        .strip_prefix('/')?
        .strip_suffix('/')
        .unwrap_or(path.strip_prefix('/')?)
        .split('/')
        .collect::<Vec<_>>();
    if parts.iter().any(|p| p.is_empty()) || !parts.first()?.eq_ignore_ascii_case("api") {
        return None;
    }
    let decode = |raw: &str| {
        percent_encoding::percent_decode_str(raw)
            .decode_utf8_lossy()
            .into_owned()
    };
    let (operation, organization_id, id) = match parts.as_slice() {
        [_, orgs, org, automations]
            if orgs.eq_ignore_ascii_case("orgs")
                && automations.eq_ignore_ascii_case("automations")
                && *method == Method::POST =>
        {
            (Operation::Create, Some(decode(org)), None)
        }
        [_, automations, id] if automations.eq_ignore_ascii_case("automations") => match *method {
            Method::PATCH => (Operation::Update, None, Some(decode(id))),
            Method::DELETE => (Operation::Delete, None, Some(decode(id))),
            _ => return None,
        },
        [_, automations, id, triggers]
            if automations.eq_ignore_ascii_case("automations")
                && triggers.eq_ignore_ascii_case("triggers")
                && *method == Method::POST =>
        {
            (Operation::TriggerCreate, None, Some(decode(id)))
        }
        [_, triggers, id] if triggers.eq_ignore_ascii_case("automation-triggers") => {
            match *method {
                Method::PATCH => (Operation::TriggerUpdate, None, Some(decode(id))),
                Method::DELETE => (Operation::TriggerDelete, None, Some(decode(id))),
                _ => return None,
            }
        }
        [_, triggers, id, rotate]
            if triggers.eq_ignore_ascii_case("automation-triggers")
                && rotate.eq_ignore_ascii_case("rotate-secret")
                && *method == Method::POST =>
        {
            (Operation::RotateSecret, None, Some(decode(id)))
        }
        _ => return None,
    };
    Some(Endpoint {
        operation,
        organization_id,
        id,
    })
}
pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path, method).is_some()
}
pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return error(404, "Automation route not found");
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
        && !body.is_empty();
    let input = if has_json {
        match std::str::from_utf8(&body)
            .ok()
            .and_then(|raw| rudder_d1_persistence::agent_core::parse_public_json_value(raw).ok())
        {
            Some(v) => v,
            None => return error(400, "Invalid request body"),
        }
    } else if matches!(
        endpoint.operation,
        Operation::Delete | Operation::TriggerDelete
    ) {
        json!({})
    } else {
        return HttpResponse::BadRequest().json(json!({"error":"Validation error","details":[{"code":"invalid_type","expected":"object","received":"undefined","path":[],"message":"Required"}]}));
    };
    if let Err(error) = normalize_input(endpoint.operation, input.clone()) {
        return failure(error);
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if state.config.identity_auth.is_none() {
        return error(503, "Rust Automation management is unavailable");
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return error(401, "Unauthorized");
    };
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
        Ok(p) => p,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return error(503, "Rust Automation management is unavailable");
    };
    let api_url = std::env::var("RUDDER_NATIVE_HOST_API_URL")
        .or_else(|_| std::env::var("RUDDER_API_URL"))
        .unwrap_or_else(|_| "undefined".to_owned());
    let run_id = match &identity {
        NativeIngressIdentity::AgentJwt(jwt) => Some(jwt.run_id.as_str()),
        _ => request
            .headers()
            .get("x-rudder-run-id")
            .and_then(|v| v.to_str().ok()),
    };
    match execute(
        pool,
        &authorizer,
        Actor {
            kind: &actor.kind,
            id: &actor.id,
            run_id,
            local_implicit: matches!(&identity, NativeIngressIdentity::LocalImplicit),
        },
        Command {
            operation: endpoint.operation,
            organization_id: endpoint.organization_id.as_deref(),
            id: endpoint.id.as_deref(),
            input: &input,
            api_url: &api_url,
        },
    )
    .await
    {
        Ok((204, _)) => HttpResponse::NoContent().finish(),
        Ok((status, value)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(value),
        Err(error) => failure(error),
    }
}
fn error(status: u16, message: &str) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(json!({"error":message}))
}
fn failure(failure: Error) -> HttpResponse {
    match failure {
        Error::Http(status, message) => error(status, &message),
        Error::Validation(details) => {
            HttpResponse::BadRequest().json(json!({"error":"Validation error","details":details}))
        }
        Error::Secret(rudder_d1_persistence::secrets::SecretsError::Http(status, message)) => {
            error(status, &message)
        }
        Error::Database(ref e) if rudder_d1_persistence::secrets::database_unavailable(e) => {
            error(503, "Rust Automation management is unavailable")
        }
        _ => error(500, "Internal server error"),
    }
}
#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_only_management_writes_and_decodes_express_captures() {
        assert_eq!(
            endpoint_for_path("/API/Orgs/%61/Automations/", &Method::POST)
                .unwrap()
                .organization_id
                .as_deref(),
            Some("a")
        );
        for path in [
            "/api/automations/a/run",
            "/api/automation-triggers/public/p/fire",
        ] {
            assert!(!is_reserved_path(path, &Method::POST));
        }
        assert!(!is_reserved_path("/api/automations/a", &Method::GET));
        assert!(is_reserved_path(
            "/api/AUTOMATION-TRIGGERS/%61/ROTATE-SECRET",
            &Method::POST
        ));
    }
    #[test]
    fn matches_public_zod_validation_oracle() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("automation_writes/validation-cases.json")).unwrap();
        for case in cases {
            let operation = match case["operation"].as_str().unwrap() {
                "create" => Operation::Create,
                "update" => Operation::Update,
                "trigger-create" => Operation::TriggerCreate,
                "trigger-update" => Operation::TriggerUpdate,
                "rotate" => Operation::RotateSecret,
                _ => panic!("unexpected fixture operation"),
            };
            match normalize_input(operation, case["input"].clone()) {
                Ok(value) => assert_eq!(value, case["output"], "{case}"),
                Err(Error::Validation(issues)) => assert_eq!(issues, case["issues"], "{case}"),
                Err(error) => panic!("unexpected error {error}: {case}"),
            }
        }
    }
}
