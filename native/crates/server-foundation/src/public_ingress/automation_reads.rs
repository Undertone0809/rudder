//! Public Automation list, detail, and run-history reads.
//!
//! The existing D1 projection owns Automation response data. This adapter
//! resolves target scope and revalidates public organization access in Rust so
//! selected ingress does not resolve targets or execute read projections in Node.

use super::*;
use crate::{
    member_directory_auth::MemberDirectoryNativeAccess, native_session_auth::NativeIngressIdentity,
};
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::{
    StoreError,
    automation_reads::{
        AutomationReadError, AutomationReadInput, AutomationReadOperation, read_automations,
    },
};
use serde_json::json;
use sqlx::Row;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    List { organization_id: String },
    Detail { automation_id: String },
    Runs { automation_id: String },
}

fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    match parts.as_slice() {
        [api, orgs, raw_org_id, automations]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && automations.eq_ignore_ascii_case("automations") =>
        {
            Some(Endpoint::List {
                organization_id: decode_capture(raw_org_id)?,
            })
        }
        [api, automations, raw_automation_id, runs]
            if api.eq_ignore_ascii_case("api")
                && automations.eq_ignore_ascii_case("automations")
                && runs.eq_ignore_ascii_case("runs") =>
        {
            Some(Endpoint::Runs {
                automation_id: decode_capture(raw_automation_id)?,
            })
        }
        [api, automations, raw_automation_id]
            if api.eq_ignore_ascii_case("api")
                && automations.eq_ignore_ascii_case("automations") =>
        {
            Some(Endpoint::Detail {
                automation_id: decode_capture(raw_automation_id)?,
            })
        }
        _ => None,
    }
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
        return HttpResponse::NotFound().json(json!({"error":"Automation route not found"}));
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
                .min(MAX_BODY_BYTES)
        {
            return HttpResponse::PayloadTooLarge()
                .json(json!({"error":"Request body is too large"}));
        }
        body.extend_from_slice(&chunk);
    }
    execute(state, request, web::Bytes::from(body), endpoint).await
}

async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    endpoint: Endpoint,
) -> HttpResponse {
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return HttpResponse::NotFound().json(json!({"error":"Not found"}));
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
    if matches!(&identity, NativeIngressIdentity::None) {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(native_auth) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };

    // Detail and runs have no organization path segment. Resolve the
    // resource's scope before authorizing, matching the existing route's
    // missing/foreign/archived response order. The D1 read rechecks the same
    // org and returns 404 if the row moved or disappeared in between.
    let mut authorization = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *authorization)
        .await
        .is_err()
    {
        return internal_error();
    }
    let organization_id = match &endpoint {
        Endpoint::List { organization_id } => organization_id.clone(),
        Endpoint::Detail { automation_id } | Endpoint::Runs { automation_id } => {
            let row = match sqlx::query(
                "SELECT org_id::text AS org_id, status FROM automations WHERE id=$1::uuid",
            )
            .bind(automation_id)
            .fetch_optional(&mut *authorization)
            .await
            {
                Ok(Some(row)) => row,
                Ok(None) => return not_found(),
                Err(_) => return internal_error(),
            };
            let organization_id = match row.try_get::<String, _>("org_id") {
                Ok(organization_id) => organization_id,
                Err(_) => return internal_error(),
            };
            let status = match row.try_get::<String, _>("status") {
                Ok(status) => status,
                Err(_) => return internal_error(),
            };
            if matches!(&endpoint, Endpoint::Detail { .. }) && status == "archived" {
                return not_found();
            }
            organization_id
        }
    };

    match native_auth
        .revalidate(&mut authorization, &organization_id)
        .await
    {
        Ok(MemberDirectoryNativeAccess::Authorized) => (),
        Ok(MemberDirectoryNativeAccess::Unauthorized) => {
            return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
        }
        Ok(MemberDirectoryNativeAccess::Forbidden) => {
            return project_reads::forbidden_response(&identity);
        }
        Err(_) => return internal_error(),
    }
    if authorization.commit().await.is_err() {
        return internal_error();
    }

    // Board and session identities carry the verified user ID used by the
    // legacy side-chat owner filter. Agents intentionally have no user owner.
    let owner = (actor.kind == "user").then_some(actor.id.as_str());
    let input = match endpoint {
        Endpoint::List { .. } => AutomationReadInput {
            operation: AutomationReadOperation::List,
            automation_id: None,
            limit: None,
        },
        Endpoint::Detail { automation_id } => AutomationReadInput {
            operation: AutomationReadOperation::Detail,
            automation_id: Some(automation_id),
            limit: None,
        },
        Endpoint::Runs { automation_id } => AutomationReadInput {
            operation: AutomationReadOperation::Runs,
            automation_id: Some(automation_id),
            limit: Some(runs_limit(&request)),
        },
    };
    match read_automations(pool, &organization_id, owner, &input).await {
        Ok(response) => HttpResponse::Ok()
            .content_type("application/json")
            .body(response),
        Err(AutomationReadError::Store(StoreError::NotFound)) => not_found(),
        Err(AutomationReadError::Store(StoreError::InvalidInput)) => {
            HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid Automation read request"}))
        }
        Err(_) => internal_error(),
    }
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn runs_limit(request: &HttpRequest) -> f64 {
    let values = url::form_urlencoded::parse(request.query_string().as_bytes())
        .filter(|(key, _)| key == "limit")
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    match values.as_slice() {
        [] => 50.0,
        [value] => {
            let limit = javascript_number(value);
            if limit.is_finite() { limit } else { 50.0 }
        }
        _ => 50.0,
    }
}

fn javascript_number(raw: &str) -> f64 {
    let value = raw.trim();
    if value.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut result = 0.0;
            for character in digits.chars() {
                let Some(digit) = character.to_digit(radix) else {
                    return f64::NAN;
                };
                result = result * f64::from(radix) + f64::from(digit);
            }
            return result;
        }
    }
    value.parse::<f64>().unwrap_or(f64::NAN)
}

fn not_found() -> HttpResponse {
    HttpResponse::NotFound().json(json!({"error":"Automation not found"}))
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_only_the_three_automation_read_shapes_for_get_and_head() {
        for path in [
            "/api/orgs/org-1/automations",
            "/API/ORGS/org-1/AUTOMATIONS/",
            "/api/automations/auto-1",
            "/api/automations/auto-1/runs",
        ] {
            assert!(is_reserved_path(path, &Method::GET), "{path}");
            assert!(is_reserved_path(path, &Method::HEAD), "{path}");
        }
        for path in [
            "/api/orgs/org-1/automations/auto-1",
            "/api/automations/auto-1/triggers",
            "/api/automations/auto-1/run",
            "/api/automations/auto-1/rotate-secret",
            "/api/orgs/org-1/automations/auto-1",
        ] {
            assert!(!is_reserved_path(path, &Method::GET), "{path}");
        }
        assert!(!is_reserved_path(
            "/api/automations/auto-1/runs",
            &Method::POST
        ));
    }

    #[test]
    fn runs_limit_matches_express_number_coercion_and_fallback() {
        for (uri, expected) in [
            ("/api/automations/a/runs", 50.0),
            ("/api/automations/a/runs?limit=", 0.0),
            ("/api/automations/a/runs?limit=-2", -2.0),
            ("/api/automations/a/runs?limit=0x2", 2.0),
            ("/api/automations/a/runs?limit=1e1", 10.0),
            ("/api/automations/a/runs?limit=Infinity", 50.0),
            ("/api/automations/a/runs?limit=2&limit=3", 50.0),
        ] {
            let request = actix_web::test::TestRequest::get()
                .uri(uri)
                .to_http_request();
            assert_eq!(runs_limit(&request), expected, "{uri}");
        }
    }
}
