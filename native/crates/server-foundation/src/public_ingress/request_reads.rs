//! Public Request list, detail, and Block Audit reads.
//!
//! D1 owns the mixed Requests/Approvals projection and redaction. This adapter
//! owns public identity and organization revalidation for the three read paths.

use super::*;
use crate::{
    member_directory_auth::MemberDirectoryNativeAccess, native_session_auth::NativeIngressIdentity,
};
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::{
    StoreError,
    request_reads::{RequestReadError, RequestReadInput, RequestReadOperation, read_requests},
};
use serde_json::json;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    List { raw_organization_id: String },
    Detail { raw_request_id: String },
    BlockAuditAttempts { raw_request_id: String },
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
        [api, orgs, raw_organization_id, requests]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && requests.eq_ignore_ascii_case("requests") =>
        {
            Some(Endpoint::List {
                raw_organization_id: (*raw_organization_id).to_owned(),
            })
        }
        [api, requests, raw_request_id, attempts]
            if api.eq_ignore_ascii_case("api")
                && requests.eq_ignore_ascii_case("requests")
                && attempts.eq_ignore_ascii_case("block-audit-attempts") =>
        {
            Some(Endpoint::BlockAuditAttempts {
                raw_request_id: (*raw_request_id).to_owned(),
            })
        }
        [api, requests, raw_request_id]
            if api.eq_ignore_ascii_case("api") && requests.eq_ignore_ascii_case("requests") =>
        {
            Some(Endpoint::Detail {
                raw_request_id: (*raw_request_id).to_owned(),
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
    let Some(raw_endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return HttpResponse::NotFound().json(json!({"error":"Request route not found"}));
    };
    let endpoint = match decode_endpoint(raw_endpoint) {
        Ok(endpoint) => endpoint,
        Err(()) => return HttpResponse::BadRequest().json(json!({"error":"Invalid request path"})),
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

fn decode_endpoint(endpoint: Endpoint) -> Result<Endpoint, ()> {
    match endpoint {
        Endpoint::List {
            raw_organization_id,
        } => Ok(Endpoint::List {
            raw_organization_id: decode_capture(&raw_organization_id)?,
        }),
        Endpoint::Detail { raw_request_id } => Ok(Endpoint::Detail {
            raw_request_id: decode_capture(&raw_request_id)?,
        }),
        Endpoint::BlockAuditAttempts { raw_request_id } => Ok(Endpoint::BlockAuditAttempts {
            raw_request_id: decode_capture(&raw_request_id)?,
        }),
    }
}

fn decode_capture(value: &str) -> Result<String, ()> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| ())
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
    let (organization_id, operation, request_id) = match endpoint {
        Endpoint::List {
            raw_organization_id,
        } => (raw_organization_id, RequestReadOperation::List, None),
        Endpoint::Detail { raw_request_id } => {
            let organization_id =
                match target_organization(&mut authorization, &raw_request_id).await {
                    Ok(Some(organization_id)) => organization_id,
                    Ok(None) => return not_found(),
                    Err(_) => return internal_error(),
                };
            (
                organization_id,
                RequestReadOperation::Detail,
                Some(raw_request_id),
            )
        }
        Endpoint::BlockAuditAttempts { raw_request_id } => {
            let organization_id =
                match target_organization(&mut authorization, &raw_request_id).await {
                    Ok(Some(organization_id)) => organization_id,
                    Ok(None) => return not_found(),
                    Err(_) => return internal_error(),
                };
            (
                organization_id,
                RequestReadOperation::BlockAuditAttempts,
                Some(raw_request_id),
            )
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

    // The legacy detail route queried target identity before asserting access,
    // so anonymous missing IDs returned 404 and malformed UUIDs returned 500.
    // Native ingress follows the shared authenticated-read ordering and returns
    // 401 before that lookup. Valid targets still resolve Requests before
    // Approvals and are rechecked by the D1 transaction below.
    let mut input = RequestReadInput {
        operation,
        request_id,
        status: None,
        kind: None,
    };
    if operation == RequestReadOperation::List {
        let mut details = Vec::new();
        match list_filter(
            &request,
            "status",
            &["open", "resolved", "cancelled", "superseded"],
        ) {
            Ok(status) => input.status = status,
            Err(issue) => details.push(issue),
        }
        match list_filter(&request, "kind", &["approval", "assistance"]) {
            Ok(kind) => input.kind = kind,
            Err(issue) => details.push(issue),
        }
        if !details.is_empty() {
            return HttpResponse::BadRequest()
                .json(json!({"error":"Validation error", "details":details}));
        }
    }

    match read_requests(pool, &organization_id, &input).await {
        Ok(response) => HttpResponse::Ok()
            .content_type("application/json")
            .body(response),
        Err(RequestReadError::Store(StoreError::NotFound)) => not_found(),
        Err(RequestReadError::Store(StoreError::InvalidInput)) => {
            HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid Request read request"}))
        }
        Err(RequestReadError::NotAssistance) => HttpResponse::UnprocessableEntity()
            .json(json!({"error":"Only Assistance Requests have Block Audit attempts"})),
        Err(_) => internal_error(),
    }
}

async fn target_organization(
    authorization: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    request_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT org_id::text FROM (SELECT org_id, 0 AS source FROM requests WHERE id=$1::uuid UNION ALL SELECT org_id, 1 AS source FROM approvals WHERE id=$1::uuid) target ORDER BY source LIMIT 1",
    )
    .bind(request_id)
    .fetch_optional(&mut **authorization)
    .await
}

fn list_filter(
    request: &HttpRequest,
    name: &str,
    allowed: &[&str],
) -> Result<Option<String>, serde_json::Value> {
    let values = url::form_urlencoded::parse(request.query_string().as_bytes())
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    let expected = allowed
        .iter()
        .map(|value| format!("'{value}'"))
        .collect::<Vec<_>>()
        .join(" | ");
    match values.as_slice() {
        [] => Ok(None),
        [value] if allowed.contains(&value.as_str()) => Ok(Some(value.clone())),
        [value] => Err(json!({
            "received":value,
            "code":"invalid_enum_value",
            "options":allowed,
            "path":[name],
            "message":format!("Invalid enum value. Expected {expected}, received '{value}'")
        })),
        _ => Err(json!({
            "expected":expected,
            "received":"array",
            "code":"invalid_type",
            "path":[name],
            "message":format!("Expected {expected}, received array")
        })),
    }
}

fn not_found() -> HttpResponse {
    HttpResponse::NotFound().json(json!({"error":"Request not found"}))
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_only_the_three_request_read_shapes_for_get_and_head() {
        for path in [
            "/api/orgs/org-1/requests",
            "/API/ORGS/org-1/REQUESTS/",
            "/api/requests/request-1",
            "/api/requests/request-1/block-audit-attempts",
        ] {
            assert!(is_reserved_path(path, &Method::GET), "GET {path}");
            assert!(is_reserved_path(path, &Method::HEAD), "HEAD {path}");
        }
        for path in [
            "/api/requests",
            "/api/orgs/org-1/requests/extra",
            "/api/requests/request-1/resolve",
        ] {
            assert!(!is_reserved_path(path, &Method::GET), "{path}");
        }
        assert!(!is_reserved_path("/api/requests/request-1", &Method::POST));
        assert!(is_reserved_path("/api/requests/%FF", &Method::GET));
    }

    #[test]
    fn list_filters_match_single_zod_enum_values_and_ignore_unknown_keys() {
        let request = |query| {
            actix_web::test::TestRequest::get()
                .uri(&format!("/api/orgs/org-1/requests?{query}"))
                .to_http_request()
        };
        assert_eq!(
            list_filter(&request("status=open&ignored=yes"), "status", &["open"]),
            Ok(Some("open".into()))
        );
        assert_eq!(
            list_filter(&request("status="), "status", &["open"]),
            Err(json!({
                "received":"", "code":"invalid_enum_value", "options":["open"],
                "path":["status"],
                "message":"Invalid enum value. Expected 'open', received ''"
            }))
        );
        assert_eq!(
            list_filter(
                &request("status=open&status=resolved"),
                "status",
                &["open", "resolved"]
            ),
            Err(json!({
                "expected":"'open' | 'resolved'", "received":"array", "code":"invalid_type",
                "path":["status"], "message":"Expected 'open' | 'resolved', received array"
            }))
        );
    }
}
