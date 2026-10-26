//! Direct Rust ownership for the organization create/update/archive/delete
//! routes. This module keeps the existing Node surface for unrelated org
//! endpoints and never forwards a selected mutation to Node.

use super::*;
use crate::{
    ActorIdentity,
    native_bearer_auth::{self, NativeBearerAccess},
    native_session_auth::{NativeIngressIdentity, NativeSessionAccess},
};
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::{StoreError, organization_mutations};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    Create,
    Patch {
        organization_id: String,
        branding: bool,
    },
    Archive(String),
    Delete(String),
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path, method).is_some() || unsupported_mutation_path(path, method)
}

fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.iter().any(|segment| segment.is_empty())
        || segments.len() < 2
        || !segments[0].eq_ignore_ascii_case("api")
        || !segments[1].eq_ignore_ascii_case("orgs")
    {
        return None;
    }
    match segments.as_slice() {
        [_, _] if *method == Method::POST => Some(Endpoint::Create),
        [_, _, raw_org] if *method == Method::PATCH => {
            decode_capture(raw_org).map(|id| Endpoint::Patch {
                organization_id: id,
                branding: false,
            })
        }
        [_, _, raw_org] if *method == Method::DELETE => {
            decode_capture(raw_org).map(Endpoint::Delete)
        }
        [_, _, raw_org, route]
            if route.eq_ignore_ascii_case("branding") && *method == Method::PATCH =>
        {
            decode_capture(raw_org).map(|id| Endpoint::Patch {
                organization_id: id,
                branding: true,
            })
        }
        [_, _, raw_org, route]
            if route.eq_ignore_ascii_case("archive") && *method == Method::POST =>
        {
            decode_capture(raw_org).map(Endpoint::Archive)
        }
        _ => None,
    }
}

fn unsupported_mutation_path(path: &str, method: &Method) -> bool {
    let normalized = path.strip_prefix('/').unwrap_or(path);
    let normalized = normalized.strip_suffix('/').unwrap_or(normalized);
    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts.len() < 2
        || !parts[0].eq_ignore_ascii_case("api")
        || !parts[1].eq_ignore_ascii_case("orgs")
    {
        return false;
    }
    match parts.as_slice() {
        [_, _] => !matches!(*method, Method::GET | Method::HEAD | Method::POST),
        [_, _, org_id] if !org_id.eq_ignore_ascii_case("import") => !matches!(
            *method,
            Method::GET | Method::HEAD | Method::PATCH | Method::DELETE
        ),
        [_, _, _, suffix] if suffix.eq_ignore_ascii_case("branding") => *method != Method::PATCH,
        [_, _, _, suffix] if suffix.eq_ignore_ascii_case("archive") => *method != Method::POST,
        _ => false,
    }
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
            json!({"error":"Not found"}),
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
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
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

    match endpoint {
        Endpoint::Create => {
            let authorizer = CreateAuthorizer {
                identity: &identity,
                kind: state
                    .config
                    .session_auth
                    .as_ref()
                    .map_or(NativeSessionAuthKind::BetterAuth, |config| config.kind),
            };
            let provisioner = WorkspaceProvisioner;
            match organization_mutations::create_public(
                pool,
                &parse_body(&body),
                &authorizer,
                &provisioner,
            )
            .await
            {
                Ok(organization) => HttpResponse::Created().json(organization),
                Err(error) => mutation_error(&state, &request, error),
            }
        }
        Endpoint::Patch {
            organization_id,
            branding,
        } => {
            let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            let Some(authorizer) =
                agent_core::native_authorizer(&identity, &actor, &session_id, &state)
            else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            let actor_kind = if actor.kind == "user" {
                "board"
            } else {
                "agent"
            };
            let agent_id = (actor.kind == "agent").then_some(actor.id.as_str());
            let run_id = agent_run_id_header(&request);
            let patch = parse_body(&body);
            match organization_mutations::patch_public(
                pool,
                organization_mutations::OrganizationPatchCommand {
                    organization_id: &organization_id,
                    body: &patch,
                    branding_route: branding,
                    actor_kind,
                    actor_id: actor.id.as_str(),
                    agent_id,
                    run_id: run_id.as_deref(),
                    idempotency_key: request
                        .headers()
                        .get("x-rudder-idempotency-key")
                        .and_then(|value| value.to_str().ok()),
                    authorizer: &authorizer,
                },
            )
            .await
            {
                Ok(organization) => HttpResponse::Ok().json(organization),
                Err(error) => mutation_error(&state, &request, error),
            }
        }
        Endpoint::Archive(organization_id) => {
            if let Some(response) = require_board_after_company_access(&identity, &organization_id)
            {
                return json_response(&request, response.0, response.1);
            }
            let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            let Some(authorizer) =
                agent_core::native_authorizer(&identity, &actor, &session_id, &state)
            else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            match organization_mutations::archive_public(
                pool,
                &organization_id,
                &actor.id,
                &authorizer,
            )
            .await
            {
                Ok(organization) => HttpResponse::Ok().json(organization),
                Err(error) => mutation_error(&state, &request, error),
            }
        }
        Endpoint::Delete(organization_id) => {
            if let Some(response) = require_board_after_company_access(&identity, &organization_id)
            {
                return json_response(&request, response.0, response.1);
            }
            let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            let Some(authorizer) =
                agent_core::native_authorizer(&identity, &actor, &session_id, &state)
            else {
                return json_response(
                    &request,
                    StatusCode::UNAUTHORIZED,
                    json!({"error":"Unauthorized"}),
                );
            };
            match organization_mutations::delete_public(pool, &organization_id, &authorizer).await {
                Ok(false) => json_response(
                    &request,
                    StatusCode::NOT_FOUND,
                    json!({"error":"Organization not found"}),
                ),
                Ok(true) => {
                    if let Err(error) =
                        agent_core::remove_organization_workspace_root(&organization_id)
                    {
                        tracing::warn!(%organization_id, ?error, "organization workspace cleanup failed after committed delete");
                    }
                    HttpResponse::Ok().json(json!({"ok":true}))
                }
                Err(error) => mutation_error(&state, &request, error),
            }
        }
    }
}

fn parse_body(body: &[u8]) -> Value {
    if body.is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(body).unwrap_or(Value::Null)
    }
}

struct CreateAuthorizer<'a> {
    identity: &'a NativeIngressIdentity,
    kind: NativeSessionAuthKind,
}

impl organization_mutations::OrganizationCreateAuthorizer for CreateAuthorizer<'_> {
    fn authorize<'a>(
        &'a self,
        connection: &'a mut sqlx::PgConnection,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<organization_mutations::OrganizationCreateActor, StoreError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let user_id = match self.identity {
                NativeIngressIdentity::LocalImplicit => {
                    return Ok(organization_mutations::OrganizationCreateActor {
                        user_id: "local-board".to_owned(),
                    });
                }
                NativeIngressIdentity::Session(identity) => {
                    match crate::native_session_auth::revalidate_instance_admin_in_snapshot(
                        connection, identity, self.kind,
                    )
                    .await?
                    {
                        NativeSessionAccess::Authorized => identity.user_id.clone(),
                        NativeSessionAccess::Unauthorized => {
                            return Err(StoreError::PublicIdentityUnauthorized);
                        }
                        NativeSessionAccess::Forbidden => {
                            return Err(StoreError::PublicIdentityForbidden);
                        }
                    }
                }
                NativeIngressIdentity::BoardKey {
                    user_id,
                    key_id,
                    token_hash,
                } => {
                    let actor = ActorIdentity::new("user", user_id)
                        .map_err(|_| StoreError::PublicIdentityUnauthorized)?;
                    match native_bearer_auth::revalidate_native_bearer_in_snapshot(
                        connection,
                        token_hash,
                        None,
                        &actor,
                        &format!("board-key:{key_id}"),
                    )
                    .await?
                    {
                        NativeBearerAccess::Authorized => {}
                        NativeBearerAccess::Unauthorized => {
                            return Err(StoreError::PublicIdentityUnauthorized);
                        }
                        NativeBearerAccess::Forbidden => {
                            return Err(StoreError::PublicIdentityForbidden);
                        }
                    }
                    let is_admin = sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')",
                    )
                    .bind(user_id)
                    .fetch_one(&mut *connection)
                    .await?;
                    if !is_admin {
                        return Err(StoreError::PublicIdentityForbidden);
                    }
                    user_id.clone()
                }
                NativeIngressIdentity::AgentKey { .. }
                | NativeIngressIdentity::AgentJwt(_)
                | NativeIngressIdentity::None => return Err(StoreError::PublicIdentityForbidden),
            };
            Ok(organization_mutations::OrganizationCreateActor { user_id })
        })
    }
}

struct WorkspaceProvisioner;

impl organization_mutations::OrganizationWorkspaceProvisioner for WorkspaceProvisioner {
    fn ensure<'a>(
        &'a self,
        organization_id: &'a str,
        organization_name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), StoreError>> + Send + 'a>> {
        Box::pin(async move {
            agent_core::ensure_named_organization_workspace_root(organization_id, organization_name)
                .map(|_| ())
                .map_err(|_| {
                    StoreError::Provisioning(
                        "organization workspace could not be prepared".to_owned(),
                    )
                })
        })
    }

    fn remove<'a>(
        &'a self,
        organization_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), StoreError>> + Send + 'a>> {
        Box::pin(async move {
            agent_core::remove_organization_workspace_root(organization_id).map_err(|_| {
                StoreError::Provisioning(
                    "organization workspace could not be removed after create rollback".to_owned(),
                )
            })
        })
    }
}

fn require_board_after_company_access(
    identity: &NativeIngressIdentity,
    organization_id: &str,
) -> Option<(StatusCode, Value)> {
    let agent_org = match identity {
        NativeIngressIdentity::AgentKey { org_id, .. } => Some(org_id.as_str()),
        NativeIngressIdentity::AgentJwt(identity) => Some(identity.org_id.as_str()),
        _ => None,
    };
    if let Some(agent_org) = agent_org {
        if agent_org != organization_id {
            return Some((
                StatusCode::FORBIDDEN,
                json!({"error":"Agent key cannot access another organization"}),
            ));
        }
        return Some((
            StatusCode::FORBIDDEN,
            json!({"error":"Board access required"}),
        ));
    }
    matches!(identity, NativeIngressIdentity::None)
        .then(|| (StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"})))
}

fn mutation_error(state: &IngressState, request: &HttpRequest, error: StoreError) -> HttpResponse {
    match error {
        StoreError::NotFound => json_response(
            request,
            StatusCode::NOT_FOUND,
            json!({"error":"Organization not found"}),
        ),
        StoreError::OrganizationConflict(message) => {
            json_response(request, StatusCode::CONFLICT, json!({"error":message}))
        }
        StoreError::OrganizationInvalid(message) => json_response(
            request,
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"error":message}),
        ),
        StoreError::PublicIdentityUnauthorized => json_response(
            request,
            StatusCode::UNAUTHORIZED,
            json!({"error":"Unauthorized"}),
        ),
        StoreError::PublicIdentityForbidden => json_response(
            request,
            StatusCode::FORBIDDEN,
            json!({"error":"Instance admin access required"}),
        ),
        other => state.foundation.mutation_error(other),
    }
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
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

    #[test]
    fn organization_mutation_aliases_are_case_insensitive_and_accept_trailing_slashes() {
        for (method, path) in [
            (Method::POST, "/API/ORGS/"),
            (
                Method::PATCH,
                "/API/ORGS/20000000-0000-4000-8000-000000000001/",
            ),
            (
                Method::PATCH,
                "/API/ORGS/20000000-0000-4000-8000-000000000001/BRANDING/",
            ),
            (
                Method::POST,
                "/API/ORGS/20000000-0000-4000-8000-000000000001/ARCHIVE/",
            ),
            (
                Method::DELETE,
                "/API/ORGS/20000000-0000-4000-8000-000000000001/",
            ),
        ] {
            assert!(is_reserved_path(path, &method), "{method} {path}");
            assert!(
                endpoint_for_path(path, &method).is_some(),
                "{method} {path}"
            );
        }
        assert!(!is_reserved_path("/api/orgs/import", &Method::POST));
        assert!(is_reserved_path("/api/orgs/abc/branding", &Method::PUT));
    }
}
