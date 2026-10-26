//! Direct Rust ownership for the legacy public organization list/detail reads.
//! Static `/stats` and `/issues` routes remain on their existing handlers.

use super::*;
use crate::{
    member_directory_auth::MemberDirectoryNativeAccess,
    native_bearer_auth::{self, NativeBearerAccess},
    native_session_auth::{NativeIngressIdentity, NativeOrganizationScope},
};
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::organization_reads::{read_organization, read_organizations};
use serde_json::{Value, json};

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    Collection,
    Detail(String),
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
        [api, orgs] if api.eq_ignore_ascii_case("api") && orgs.eq_ignore_ascii_case("orgs") => {
            Some(Endpoint::Collection)
        }
        [api, orgs, raw_org_id]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && !raw_org_id.eq_ignore_ascii_case("stats")
                && !raw_org_id.eq_ignore_ascii_case("issues") =>
        {
            decode_capture(raw_org_id).map(Endpoint::Detail)
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
        return json_response(
            &request,
            StatusCode::NOT_FOUND,
            json!({"error":"Organization route not found"}),
        );
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return json_response(
                &request,
                StatusCode::BAD_REQUEST,
                json!({"error":"Invalid request body"}),
            );
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(MAX_BODY_BYTES)
        {
            return json_response(
                &request,
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error":"Request body is too large"}),
            );
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
        return json_response(
            &request,
            StatusCode::NOT_FOUND,
            json!({"error":"Not found"}),
        );
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return foundation_error(
            &state,
            &request,
            StatusCode::BAD_REQUEST,
            "invalid_forwarding_identity",
        );
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return foundation_error(
                &state,
                &request,
                StatusCode::SERVICE_UNAVAILABLE,
                "request_queue_full",
            );
        }
    };
    if state.config.identity_auth.is_none() {
        return foundation_error(
            &state,
            &request,
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return foundation_error(
            &state,
            &request,
            StatusCode::SERVICE_UNAVAILABLE,
            "database_disabled",
        );
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, reason)) => return foundation_error(&state, &request, status, reason),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }

    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(&state, &request),
    };
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return internal_error(&state, &request);
    }

    let response = match endpoint {
        Endpoint::Collection => {
            let allowed_organization_ids =
                match organization_list_scope(&state, &identity, &mut tx).await {
                    Ok(scope) => scope,
                    Err((status, body)) => return json_response(&request, status, body),
                };
            match read_organizations(
                &mut tx,
                allowed_organization_ids.as_deref(),
                time::OffsetDateTime::now_utc(),
            )
            .await
            {
                Ok(rows) => json_response(&request, StatusCode::OK, json!(rows)),
                Err(error) => {
                    tracing::warn!(error = %error, "native organization list projection failed");
                    internal_error(&state, &request)
                }
            }
        }
        Endpoint::Detail(organization_id) => {
            if matches!(&identity, NativeIngressIdentity::None) {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            }
            let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            let Some(native_auth) =
                agent_core::native_authorizer(&identity, &actor, &session_id, &state)
            else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            match native_auth.revalidate(&mut tx, &organization_id).await {
                Ok(MemberDirectoryNativeAccess::Authorized) => {}
                Ok(MemberDirectoryNativeAccess::Unauthorized) => {
                    return json_response(
                        &request,
                        StatusCode::UNAUTHORIZED,
                        json!({"error":"Unauthorized"}),
                    );
                }
                Ok(MemberDirectoryNativeAccess::Forbidden) => {
                    return forbidden_response(&request, &identity);
                }
                Err(error) => {
                    tracing::warn!(error = %error, "native organization access revalidation failed");
                    return internal_error(&state, &request);
                }
            }
            match read_organization(&mut tx, &organization_id, time::OffsetDateTime::now_utc())
                .await
            {
                Ok(Some(organization)) => json_response(&request, StatusCode::OK, organization),
                Ok(None) => json_response(
                    &request,
                    StatusCode::NOT_FOUND,
                    json!({"error":"Organization not found"}),
                ),
                Err(error) => {
                    tracing::warn!(error = %error, "native organization detail projection failed");
                    internal_error(&state, &request)
                }
            }
        }
    };
    if tx.commit().await.is_err() {
        return internal_error(&state, &request);
    }
    response
}

pub(super) async fn organization_list_scope(
    state: &IngressState,
    identity: &NativeIngressIdentity,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> Result<Option<Vec<String>>, (StatusCode, Value)> {
    match identity {
        NativeIngressIdentity::LocalImplicit => Ok(None),
        NativeIngressIdentity::Session(session) => {
            let kind = state
                .config
                .session_auth
                .as_ref()
                .map_or(NativeSessionAuthKind::BetterAuth, |config| config.kind);
            match crate::native_session_auth::organization_scope_in_snapshot(tx, session, kind)
                .await
            {
                Ok(NativeOrganizationScope::Unrestricted) => Ok(None),
                Ok(NativeOrganizationScope::Restricted(organization_ids)) => {
                    Ok(Some(organization_ids))
                }
                Ok(NativeOrganizationScope::Unauthorized) => {
                    Err((StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"})))
                }
                Err(error) => {
                    tracing::warn!(error = %error, "native organization-list session revalidation failed");
                    Err((StatusCode::INTERNAL_SERVER_ERROR, internal_error_body()))
                }
            }
        }
        NativeIngressIdentity::BoardKey {
            user_id,
            key_id,
            token_hash,
        } => {
            let Ok(actor) = ActorIdentity::new("user", user_id) else {
                return Err((StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"})));
            };
            let session_id = format!("board-key:{key_id}");
            match native_bearer_auth::revalidate_native_bearer_in_snapshot(
                tx,
                token_hash,
                None,
                &actor,
                &session_id,
            )
            .await
            {
                Ok(NativeBearerAccess::Authorized) => {}
                Ok(NativeBearerAccess::Unauthorized) => {
                    return Err((StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"})));
                }
                Ok(NativeBearerAccess::Forbidden) => {
                    return Err((
                        StatusCode::FORBIDDEN,
                        json!({"error":"Board access required"}),
                    ));
                }
                Err(error) => {
                    tracing::warn!(error = %error, "native organization-list key revalidation failed");
                    return Err((StatusCode::INTERNAL_SERVER_ERROR, internal_error_body()));
                }
            }
            match crate::native_session_auth::organization_scope_for_user_in_snapshot(tx, user_id)
                .await
            {
                Ok(NativeOrganizationScope::Unrestricted) => Ok(None),
                Ok(NativeOrganizationScope::Restricted(organization_ids)) => {
                    Ok(Some(organization_ids))
                }
                Ok(NativeOrganizationScope::Unauthorized) => {
                    Err((StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"})))
                }
                Err(error) => {
                    tracing::warn!(error = %error, "native organization-list scope query failed");
                    Err((StatusCode::INTERNAL_SERVER_ERROR, internal_error_body()))
                }
            }
        }
        NativeIngressIdentity::AgentKey { .. } | NativeIngressIdentity::AgentJwt(_) => Err((
            StatusCode::FORBIDDEN,
            json!({"error":"Board access required"}),
        )),
        NativeIngressIdentity::None => {
            Err((StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"})))
        }
    }
}

fn forbidden_response(request: &HttpRequest, identity: &NativeIngressIdentity) -> HttpResponse {
    let message = if matches!(
        identity,
        NativeIngressIdentity::AgentKey { .. } | NativeIngressIdentity::AgentJwt(_)
    ) {
        "Agent key cannot access another organization"
    } else {
        "User does not have access to this organization"
    };
    json_response(request, StatusCode::FORBIDDEN, json!({"error":message}))
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn internal_error(_state: &IngressState, request: &HttpRequest) -> HttpResponse {
    foundation_error(
        _state,
        request,
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_server_error",
    )
}

fn internal_error_body() -> Value {
    json!({
        "schema": "rudder.native.server.error.v1",
        "status": "error",
        "reason": "internal_server_error",
    })
}

fn foundation_error(
    _state: &IngressState,
    request: &HttpRequest,
    status: StatusCode,
    reason: &'static str,
) -> HttpResponse {
    json_response(
        request,
        status,
        json!({
            "schema": "rudder.native.server.error.v1",
            "status": "error",
            "reason": reason,
        }),
    )
}

fn json_response(request: &HttpRequest, status: StatusCode, body: Value) -> HttpResponse {
    if request.method() == Method::HEAD {
        let encoded = serde_json::to_vec(&body).unwrap_or_default();
        HttpResponse::build(status)
            .content_type("application/json")
            .insert_header((header::CONTENT_LENGTH, encoded.len().to_string()))
            .finish()
    } else {
        HttpResponse::build(status).json(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    #[test]
    fn only_collection_and_detail_reads_are_rust_owned() {
        for path in ["/api/orgs", "/API/ORGS/", "/Api/Orgs"] {
            assert_eq!(
                endpoint_for_path(path, &Method::GET),
                Some(Endpoint::Collection)
            );
            assert!(is_reserved_path(path, &Method::HEAD));
        }
        for path in [
            "/api/orgs/10000000-0000-4000-8000-000000000001",
            "/API/ORGS/10000000-0000-4000-8000-000000000001/",
        ] {
            assert!(matches!(
                endpoint_for_path(path, &Method::GET),
                Some(Endpoint::Detail(_))
            ));
            assert!(is_reserved_path(path, &Method::HEAD));
        }
        for path in [
            "/api/orgs/stats",
            "/API/ORGS/ISSUES/",
            "/api/orgs/org-id/resources",
            "/api/orgs/org-id/extra",
            "/api/orgs//",
        ] {
            assert_eq!(endpoint_for_path(path, &Method::GET), None, "{path}");
        }
        assert!(endpoint_for_path("/api/orgs", &Method::POST).is_none());
        let encoded_static = endpoint_for_path("/api/orgs/%73tats", &Method::GET);
        assert_eq!(encoded_static, Some(Endpoint::Detail("stats".to_owned())));
    }

    #[test]
    fn express_static_route_shadows_are_not_captured_as_organization_detail() {
        for method in [Method::GET, Method::HEAD] {
            let stats = TestRequest::default()
                .method(method.clone())
                .uri("/api/orgs/STATS/")
                .to_http_request();
            let issues = TestRequest::default()
                .method(method.clone())
                .uri("/api/orgs/Issues")
                .to_http_request();
            assert!(!is_reserved_path(stats.path(), stats.method()));
            assert!(!is_reserved_path(issues.path(), issues.method()));
        }
    }
}
