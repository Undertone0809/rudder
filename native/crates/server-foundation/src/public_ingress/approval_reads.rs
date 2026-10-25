//! Rust-owned public Approval, association, and Label read routes.
//!
//! The D1 projection remains the source of response data. These handlers
//! authenticate on the public listener and revalidate organization access
//! before invoking that existing read-only projection.

use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::StoreError;
use rudder_d1_persistence::approval_reads::{
    ApprovalReadError, ApprovalReadInput, ApprovalReadOperation, read_approvals,
};
use serde_json::json;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    List { organization_id: String },
    Detail { approval_id: String },
    Issues { approval_id: String },
    IssueApprovals { issue_reference: String },
    Labels { organization_id: String },
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD) && endpoint_path_shape(path)
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path()) else {
        return HttpResponse::BadRequest().json(json!({"error":"Invalid Approval read request"}));
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

fn endpoint_for_path(path: &str) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    match parts.as_slice() {
        [api, orgs, organization_id, approvals]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && approvals.eq_ignore_ascii_case("approvals") =>
        {
            Some(Endpoint::List {
                organization_id: decode_capture(organization_id)?,
            })
        }
        [api, orgs, organization_id, labels]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && labels.eq_ignore_ascii_case("labels") =>
        {
            Some(Endpoint::Labels {
                organization_id: decode_capture(organization_id)?,
            })
        }
        [api, approvals, approval_id, issues]
            if api.eq_ignore_ascii_case("api")
                && approvals.eq_ignore_ascii_case("approvals")
                && issues.eq_ignore_ascii_case("issues") =>
        {
            Some(Endpoint::Issues {
                approval_id: decode_capture(approval_id)?,
            })
        }
        [api, issues, issue_id, approvals]
            if api.eq_ignore_ascii_case("api")
                && issues.eq_ignore_ascii_case("issues")
                && approvals.eq_ignore_ascii_case("approvals") =>
        {
            Some(Endpoint::IssueApprovals {
                issue_reference: decode_capture(issue_id)?,
            })
        }
        [api, approvals, approval_id]
            if api.eq_ignore_ascii_case("api") && approvals.eq_ignore_ascii_case("approvals") =>
        {
            Some(Endpoint::Detail {
                approval_id: decode_capture(approval_id)?,
            })
        }
        _ => None,
    }
}

fn endpoint_path_shape(path: &str) -> bool {
    let Some(path) = path.strip_prefix('/') else {
        return false;
    };
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    matches!(parts.as_slice(), [api, orgs, _, approvals]
        if api.eq_ignore_ascii_case("api") && orgs.eq_ignore_ascii_case("orgs") && approvals.eq_ignore_ascii_case("approvals"))
        || matches!(parts.as_slice(), [api, approvals, _]
            if api.eq_ignore_ascii_case("api") && approvals.eq_ignore_ascii_case("approvals"))
        || matches!(parts.as_slice(), [api, approvals, _, issues]
            if api.eq_ignore_ascii_case("api") && approvals.eq_ignore_ascii_case("approvals") && issues.eq_ignore_ascii_case("issues"))
        || matches!(parts.as_slice(), [api, issues, _, approvals]
            if api.eq_ignore_ascii_case("api") && issues.eq_ignore_ascii_case("issues") && approvals.eq_ignore_ascii_case("approvals"))
        || matches!(parts.as_slice(), [api, orgs, _, labels]
            if api.eq_ignore_ascii_case("api") && orgs.eq_ignore_ascii_case("orgs") && labels.eq_ignore_ascii_case("labels"))
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn status_query(query: &str) -> Option<String> {
    let values = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == "status")
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    match values.as_slice() {
        [] => None,
        [single] if single.is_empty() => None,
        [single] => Some(single.clone()),
        _ => Some(values.join(",")),
    }
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
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *authorization)
        .await
        .is_err()
    {
        return internal_error();
    }

    let (organization_id, operation, target_id, target_kind) = match endpoint {
        Endpoint::List { organization_id } => {
            (organization_id, ApprovalReadOperation::List, None, None)
        }
        Endpoint::Labels { organization_id } => {
            (organization_id, ApprovalReadOperation::Labels, None, None)
        }
        Endpoint::Detail { approval_id } => (
            match target_organization(&mut authorization, "approvals", &approval_id).await {
                Ok(Some(organization_id)) => organization_id,
                Ok(None) => return not_found("Approval not found"),
                Err(()) => return internal_error(),
            },
            ApprovalReadOperation::Detail,
            Some(approval_id),
            Some("approval"),
        ),
        Endpoint::Issues { approval_id } => (
            match target_organization(&mut authorization, "approvals", &approval_id).await {
                Ok(Some(organization_id)) => organization_id,
                Ok(None) => return not_found("Approval not found"),
                Err(()) => return internal_error(),
            },
            ApprovalReadOperation::Issues,
            Some(approval_id),
            Some("approval"),
        ),
        Endpoint::IssueApprovals { issue_reference } => {
            match resolve_issue_reference(&mut authorization, &identity, &issue_reference).await {
                Ok(Some((issue_id, organization_id))) => (
                    organization_id,
                    ApprovalReadOperation::IssueApprovals,
                    Some(issue_id),
                    Some("issue"),
                ),
                Ok(None) => return not_found("Issue not found"),
                Err(IssueReferenceError::Invalid) => {
                    return HttpResponse::UnprocessableEntity().json(json!({
                        "error":"Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference"
                    }));
                }
                Err(IssueReferenceError::NotFound(message)) => {
                    return not_found(&message);
                }
                Err(IssueReferenceError::Ambiguous(reference)) => {
                    return HttpResponse::Conflict().json(json!({
                        "error":"Issue ID short reference is ambiguous in this organization. Use a longer typed ref.",
                        "details":{"reference":reference}
                    }));
                }
                Err(IssueReferenceError::Internal) => return internal_error(),
            }
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

    let timezone = match sqlx::query_scalar::<_, String>("SELECT current_setting('TimeZone')")
        .fetch_one(pool)
        .await
    {
        Ok(timezone) => timezone,
        Err(_) => return internal_error(),
    };
    let input = ApprovalReadInput {
        operation,
        target_id,
        status: (operation == ApprovalReadOperation::List)
            .then(|| status_query(request.query_string()))
            .flatten(),
        legacy_date_timezone: Some(timezone),
    };
    match read_approvals(pool, &organization_id, &input).await {
        Ok(response) => HttpResponse::Ok()
            .content_type("application/json")
            .body(response),
        Err(ApprovalReadError::Store(StoreError::NotFound)) => {
            not_found(if target_kind == Some("issue") {
                "Issue not found"
            } else {
                "Approval not found"
            })
        }
        Err(ApprovalReadError::Store(StoreError::InvalidInput)) => {
            HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid Approval read request"}))
        }
        Err(_) => internal_error(),
    }
}

async fn target_organization(
    connection: &mut sqlx::PgConnection,
    table: &'static str,
    id: &str,
) -> Result<Option<String>, ()> {
    let query = match table {
        "approvals" => "SELECT org_id::text FROM approvals WHERE id=$1::uuid",
        "issues" => "SELECT org_id::text FROM issues WHERE id=$1::uuid",
        _ => return Err(()),
    };
    sqlx::query_scalar::<_, String>(query)
        .bind(id)
        .fetch_optional(connection)
        .await
        .map_err(|_| ())
}

enum IssueReferenceError {
    Invalid,
    NotFound(String),
    Ambiguous(String),
    Internal,
}

async fn resolve_issue_reference(
    connection: &mut sqlx::PgConnection,
    identity: &NativeIngressIdentity,
    raw_reference: &str,
) -> Result<Option<(String, String)>, IssueReferenceError> {
    if issue_uuid_like(raw_reference) {
        let issue_id = trim_ecmascript_whitespace(raw_reference);
        let organization_id =
            sqlx::query_scalar::<_, String>("SELECT org_id::text FROM issues WHERE id=$1::uuid")
                .bind(issue_id)
                .fetch_optional(&mut *connection)
                .await
                .map_err(|_| IssueReferenceError::Internal)?;
        return Ok(organization_id.map(|org| (issue_id.to_ascii_lowercase(), org)));
    }

    if let Some((prefix, number)) = issue_identifier(raw_reference) {
        let direct = sqlx::query_as::<_, (String, String)>(
            "SELECT id::text,org_id::text FROM issues WHERE identifier=$1",
        )
        .bind(raw_reference.to_ascii_uppercase())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| IssueReferenceError::Internal)?;
        if direct.is_some() {
            return Ok(direct);
        }

        let number = number
            .parse::<i32>()
            .map_err(|_| IssueReferenceError::Internal)?;
        let aliased = sqlx::query_as::<_, (String, String)>(
            "SELECT i.id::text,i.org_id::text FROM organization_issue_prefix_aliases a JOIN issues i ON i.org_id=a.org_id AND i.issue_number=$2 WHERE a.prefix=$1",
        )
        .bind(prefix.to_ascii_uppercase())
        .bind(number)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| IssueReferenceError::Internal)?;
        // The legacy router falls back to UUID lookup when neither identifier
        // form resolves; PostgreSQL reports that invalid UUID as a 500.
        return aliased.map_or(Err(IssueReferenceError::Internal), |issue| Ok(Some(issue)));
    }

    if let Some((kind, prefix, normalized)) = short_issue_reference(raw_reference) {
        if kind != "iss" {
            return Err(IssueReferenceError::Invalid);
        }
        let organization_ids = authorized_issue_organization_scope(connection, identity).await?;
        let rows = match organization_ids {
            Some(organizations) if organizations.is_empty() => Vec::new(),
            Some(organizations) => {
                sqlx::query_as::<_, (String, String)>(
                    "SELECT id::text,org_id::text FROM issues WHERE org_id::text=ANY($1::text[]) AND replace(lower(id::text),'-','') LIKE $2 ORDER BY id LIMIT 2",
                )
                .bind(organizations)
                .bind(format!("{prefix}%"))
                .fetch_all(&mut *connection)
                .await
                .map_err(|_| IssueReferenceError::Internal)?
            }
            None => {
                sqlx::query_as::<_, (String, String)>(
                    "SELECT id::text,org_id::text FROM issues WHERE replace(lower(id::text),'-','') LIKE $1 ORDER BY id LIMIT 2",
                )
                .bind(format!("{prefix}%"))
                .fetch_all(&mut *connection)
                .await
                .map_err(|_| IssueReferenceError::Internal)?
            }
        };
        return match rows.as_slice() {
            [] => Err(IssueReferenceError::NotFound(
                "Issue ID short reference not found in this organization".to_owned(),
            )),
            [issue] => Ok(Some(issue.clone())),
            _ => Err(IssueReferenceError::Ambiguous(normalized)),
        };
    }

    if has_typed_reference_prefix(raw_reference) {
        return Err(IssueReferenceError::Invalid);
    }

    // This matches the legacy fallback to `getById(raw_reference)` for path
    // strings that are neither UUIDs nor recognized references.
    Err(IssueReferenceError::Internal)
}

async fn authorized_issue_organization_scope(
    connection: &mut sqlx::PgConnection,
    identity: &NativeIngressIdentity,
) -> Result<Option<Vec<String>>, IssueReferenceError> {
    match identity {
        NativeIngressIdentity::LocalImplicit => Ok(None),
        NativeIngressIdentity::AgentKey { org_id, .. } => Ok(Some(vec![org_id.clone()])),
        NativeIngressIdentity::AgentJwt(identity) => Ok(Some(vec![identity.org_id.clone()])),
        NativeIngressIdentity::None => Ok(Some(Vec::new())),
        NativeIngressIdentity::Session(identity) => {
            board_issue_organization_scope(connection, &identity.user_id).await
        }
        NativeIngressIdentity::BoardKey { user_id, .. } => {
            board_issue_organization_scope(connection, user_id).await
        }
    }
}

async fn board_issue_organization_scope(
    connection: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<Option<Vec<String>>, IssueReferenceError> {
    let instance_admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')",
    )
    .bind(user_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| IssueReferenceError::Internal)?;
    if instance_admin {
        return Ok(None);
    }
    sqlx::query_scalar::<_, String>(
        "SELECT org_id::text FROM organization_memberships WHERE principal_type='user' AND principal_id=$1 AND status='active'",
    )
    .bind(user_id)
    .fetch_all(connection)
    .await
    .map(Some)
    .map_err(|_| IssueReferenceError::Internal)
}

fn issue_uuid_like(value: &str) -> bool {
    let bytes = trim_ecmascript_whitespace(value).as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                true
            } else if index == 14 {
                matches!(byte.to_ascii_lowercase(), b'1'..=b'5')
            } else if index == 19 {
                matches!(byte.to_ascii_lowercase(), b'8'..=b'b')
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn issue_identifier(value: &str) -> Option<(&str, &str)> {
    let (prefix, number) = value.split_once('-')?;
    let mut chars = prefix.bytes();
    if !chars.next()?.is_ascii_alphabetic()
        || !chars.all(|byte| byte.is_ascii_alphanumeric())
        || number.is_empty()
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((prefix, number))
}

fn short_issue_reference(value: &str) -> Option<(String, String, String)> {
    let normalized = trim_ecmascript_whitespace(value);
    let (kind, prefix) = normalized.split_once('_')?;
    if kind.len() != 3
        || !(8..=32).contains(&prefix.len())
        || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    let kind = kind.to_ascii_lowercase();
    let prefix = prefix.to_ascii_lowercase();
    Some((kind.clone(), prefix.clone(), format!("{kind}_{prefix}")))
}

fn has_typed_reference_prefix(value: &str) -> bool {
    value.as_bytes().get(0..4).is_some_and(|prefix| {
        prefix[0].is_ascii_alphabetic()
            && prefix[1].is_ascii_alphabetic()
            && prefix[2].is_ascii_alphabetic()
            && prefix[3] == b'_'
    })
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

fn not_found(message: &str) -> HttpResponse {
    HttpResponse::NotFound().json(json!({"error":message}))
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_only_the_five_approval_and_label_read_shapes() {
        for path in [
            "/api/orgs/org-1/approvals",
            "/API/ORGS/org-1/APPROVALS/",
            "/api/approvals/a1",
            "/api/approvals/a1/issues",
            "/api/issues/i1/approvals",
            "/api/orgs/org-1/labels",
        ] {
            assert!(is_reserved_path(path, &Method::GET), "{path}");
            assert!(endpoint_for_path(path).is_some(), "{path}");
        }
        for path in [
            "/api/approvals",
            "/api/approvals/a1/comments",
            "/api/orgs/org-1/labels/a1",
            "/api/orgs/org-1/approvals/a1",
        ] {
            assert!(!is_reserved_path(path, &Method::GET), "{path}");
        }
        assert!(!is_reserved_path("/api/approvals/a1", &Method::POST));
        assert!(is_reserved_path("/api/approvals/%FF", &Method::GET));
        assert!(endpoint_for_path("/api/approvals/%FF").is_none());
    }

    #[test]
    fn status_query_matches_express_simple_parser_string_coercion() {
        for (query, expected) in [
            ("", None),
            ("status=", None),
            ("status=pending", Some("pending".to_owned())),
            (
                "status=pending&status=approved",
                Some("pending,approved".to_owned()),
            ),
            ("status=&status=", Some(",".to_owned())),
            ("status%5B%5D=pending", None),
            ("status%5Bx%5D=pending", None),
        ] {
            assert_eq!(status_query(query), expected, "{query}");
        }
    }
}
