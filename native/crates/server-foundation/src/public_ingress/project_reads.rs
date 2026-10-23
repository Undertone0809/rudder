//! Rust-owned public Project GET routes. Authentication and alias resolution
//! are organization-scoped; the D1 projection remains the response authority.

use super::*;
use actix_web::{HttpRequest, HttpResponse, http::Method, web};
use futures_util::StreamExt;
use rudder_d1_persistence::project_reads::{
    ProjectReferenceResolution, is_project_uuid_like, project_organization_id_in_snapshot,
    read_projects_in_snapshot, resolve_project_reference_in_snapshot,
};
use serde_json::json;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    Collection(String),
    Detail(String),
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD) && endpoint_path_shape(path)
}

pub(super) async fn collection(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    execute(
        state,
        request,
        body,
        Endpoint::Collection(org_id.into_inner()),
    )
    .await
}

pub(super) async fn detail(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    project_ref: web::Path<String>,
) -> HttpResponse {
    execute(
        state,
        request,
        body,
        Endpoint::Detail(project_ref.into_inner()),
    )
    .await
}

/// Express-compatible casing and optional trailing slash are handled before
/// the public proxy. Only these two GET shapes are reserved; Project writes
/// and `/projects/:id/resources` continue through their existing Node routes.
pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path()) else {
        return HttpResponse::BadRequest().json(json!({"error":"Invalid Project reference"}));
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len()) > state.foundation.config.max_request_bytes {
            return HttpResponse::PayloadTooLarge()
                .json(json!({"error":"Request body is too large"}));
        }
        body.extend_from_slice(&chunk);
    }
    execute(state, request, web::Bytes::from(body), endpoint).await
}

fn endpoint_for_path(path: &str) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let segments: Vec<_> = path.split('/').collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    match segments.as_slice() {
        [api, orgs, org_id, projects]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && projects.eq_ignore_ascii_case("projects") =>
        {
            decode_capture(org_id).map(Endpoint::Collection)
        }
        [api, projects, project_ref]
            if api.eq_ignore_ascii_case("api") && projects.eq_ignore_ascii_case("projects") =>
        {
            decode_capture(project_ref).map(Endpoint::Detail)
        }
        _ => None,
    }
}

fn endpoint_path_shape(path: &str) -> bool {
    let Some(path) = path.strip_prefix('/') else {
        return false;
    };
    let path = path.strip_suffix('/').unwrap_or(path);
    let segments: Vec<_> = path.split('/').collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return false;
    }
    matches!(
        segments.as_slice(),
        [api, orgs, _org_id, projects]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && projects.eq_ignore_ascii_case("projects")
    ) || matches!(
        segments.as_slice(),
        [api, projects, _project_ref]
            if api.eq_ignore_ascii_case("api") && projects.eq_ignore_ascii_case("projects")
    )
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn route_not_found() -> HttpResponse {
    HttpResponse::NotFound().json(json!({"error":"Project not found"}))
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
        return route_not_found();
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

    // Node does the global UUID detail existence lookup before company access.
    // Preserve that observable 404 ordering; aliases remain scoped and never
    // use this global lookup.
    let detail_uuid = match &endpoint {
        Endpoint::Detail(reference) if is_project_uuid_like(reference) => {
            Some(trim_ecmascript_whitespace(reference).to_owned())
        }
        _ => None,
    };
    let pool = match &state.foundation.database {
        DatabaseState::Configured(pool) => pool,
        DatabaseState::Disabled => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        }
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }

    let detail_query_org = match &endpoint {
        Endpoint::Detail(reference) if detail_uuid.is_none() => {
            query_organization_id(request.query_string())
        }
        _ => None,
    };
    if matches!(&identity, NativeIngressIdentity::None) {
        let unscoped_alias = matches!(&endpoint, Endpoint::Detail(_))
            && detail_uuid.is_none()
            && detail_query_org.is_none()
            && agent_organization_id(&identity).is_none();
        return if unscoped_alias {
            route_not_found()
        } else {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        };
    }

    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return internal_error();
    }

    // The Node route ran after the global authentication middleware. Keep the
    // UUID existence-before-organization-check behavior, but never perform the
    // lookup for a request whose public identity has not been authenticated.
    let global_detail_org = if let Some(project_id) = detail_uuid.as_deref() {
        match project_organization_id_in_snapshot(&mut *tx, project_id).await {
            Ok(Some(org_id)) => Some(org_id),
            Ok(None) => return route_not_found(),
            Err(_) => return internal_error(),
        }
    } else {
        None
    };

    let (org_id, alias) = match &endpoint {
        Endpoint::Collection(org_id) => (org_id.clone(), None),
        Endpoint::Detail(_reference) if detail_uuid.is_some() => (
            global_detail_org.expect("UUID detail organization was read"),
            None,
        ),
        Endpoint::Detail(reference) => {
            if let Some(org_id) = detail_query_org {
                (
                    org_id,
                    Some(trim_ecmascript_whitespace(reference).to_owned()),
                )
            } else if let Some(org_id) = agent_organization_id(&identity) {
                (
                    org_id.to_owned(),
                    Some(trim_ecmascript_whitespace(reference).to_owned()),
                )
            } else {
                // The legacy router only resolves a non-UUID Project alias for
                // Agents unless a board supplies orgId explicitly.
                return route_not_found();
            }
        }
    };
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
    match native_auth.revalidate(&mut *tx, &org_id).await {
        Ok(MemberDirectoryNativeAccess::Authorized) => (),
        Ok(MemberDirectoryNativeAccess::Unauthorized) => {
            return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
        }
        Ok(MemberDirectoryNativeAccess::Forbidden) => {
            return forbidden_response(&identity);
        }
        Err(_) => return internal_error(),
    }
    if !valid_project_organization_id(&org_id) {
        return HttpResponse::UnprocessableEntity().json(json!({
            "error":"Invalid Project read request",
            "code":"project_read_invalid"
        }));
    }
    let workspace_root = match agent_core::organization_workspace_root(&org_id.to_ascii_lowercase())
    {
        Ok(path) => path,
        Err(()) => return unavailable_error(),
    };

    let project_id = if let Some(reference) = alias.as_deref() {
        match resolve_project_reference_in_snapshot(&mut *tx, &org_id, reference).await {
            Ok(ProjectReferenceResolution::Found(project_id)) => Some(project_id),
            Ok(ProjectReferenceResolution::NotFound) => return route_not_found(),
            Ok(ProjectReferenceResolution::Ambiguous) => {
                return HttpResponse::Conflict().json(json!({
                    "error":"Project shortname is ambiguous in this organization. Use the project ID."
                }));
            }
            Err(_) => return internal_error(),
        }
    } else {
        detail_uuid.clone()
    };
    let response = match read_projects_in_snapshot(
        &mut *tx,
        &org_id,
        project_id.as_deref(),
        false,
        &workspace_root,
    )
    .await
    {
        Ok(response) => response,
        Err(rudder_d1_persistence::StoreError::NotFound) => return route_not_found(),
        Err(_) => return internal_error(),
    };
    if tx.commit().await.is_err() {
        return internal_error();
    }
    HttpResponse::Ok().json(response)
}

fn query_organization_id(query: &str) -> Option<String> {
    let mut values = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == "orgId")
        .map(|(_, value)| value.into_owned());
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let value = trim_ecmascript_whitespace(&value);
    (!value.is_empty()).then(|| value.to_owned())
}

fn agent_organization_id(identity: &NativeIngressIdentity) -> Option<&str> {
    match identity {
        NativeIngressIdentity::AgentKey { org_id, .. } => Some(org_id),
        NativeIngressIdentity::AgentJwt(identity) => Some(&identity.org_id),
        _ => None,
    }
}

fn forbidden_response(identity: &NativeIngressIdentity) -> HttpResponse {
    let message = if matches!(
        identity,
        NativeIngressIdentity::AgentKey { .. } | NativeIngressIdentity::AgentJwt(_)
    ) {
        "Agent key cannot access another organization"
    } else {
        "User does not have access to this organization"
    };
    HttpResponse::Forbidden().json(json!({"error":message}))
}

fn valid_project_organization_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(|ch| {
        matches!(
            ch,
            '\u{0009}'..='\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    })
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}

fn unavailable_error() -> HttpResponse {
    HttpResponse::ServiceUnavailable().json(json!({
        "error":"Rust Project reads are unavailable",
        "code":"rust_foundation_project_read_request_failed"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_project_list_and_detail_get_shapes_are_reserved() {
        for (path, expected) in [
            ("/api/orgs/org-1/projects", true),
            ("/API/ORGS/org-1/PROJECTS/", true),
            ("/api/projects/prj_12345678", true),
            ("/api/projects/prj_12345678/", true),
            ("/api/projects/prj_12345678/resources", false),
            ("/api/orgs/org-1/projects/p-1", false),
            ("/api/projects", false),
        ] {
            assert_eq!(endpoint_for_path(path).is_some(), expected, "{path}");
        }
        assert!(endpoint_path_shape("/api/projects/%FF"));
        assert!(is_reserved_path("/api/projects/%FF", &Method::GET));
        assert!(endpoint_for_path("/api/projects/%FF").is_none());
        assert!(!is_reserved_path(
            "/api/projects/prj_12345678",
            &Method::PATCH
        ));
        assert!(is_reserved_path(
            "/api/projects/prj_12345678",
            &Method::HEAD
        ));
    }

    #[test]
    fn query_org_matches_single_express_string_and_ignores_duplicates() {
        assert_eq!(query_organization_id("orgId=one"), Some("one".to_owned()));
        assert_eq!(
            query_organization_id("orgId=%20one%20"),
            Some("one".to_owned())
        );
        assert_eq!(query_organization_id("orgId=one&orgId=two"), None);
        assert_eq!(query_organization_id("orgid=one"), None);
        assert_eq!(query_organization_id("orgId=%20"), None);
    }
}
