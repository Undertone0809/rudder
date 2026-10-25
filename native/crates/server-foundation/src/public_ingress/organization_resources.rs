//! Public organization catalog and resource authority.
//!
//! This endpoint uses the existing public identity resolver and D1 catalog
//! projections. Resource writes claim the individual legacy resource row in
//! the same transaction as the mutation; they do not claim attached Projects.

use super::*;
use crate::member_directory_auth::MemberDirectoryNativeAuth;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::{
    OrganizationResourceCommand, OrganizationResourceCreateCommand, OrganizationResourceOperation,
    PublicOrganizationResourceError, ResultState, StoreError,
    agent_core::NativeAgentAuthorizer,
    organization_catalog_reads::{
        OrganizationCatalogReadError, OrganizationCatalogReadInput,
        OrganizationCatalogReadOperation,
    },
};
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Endpoint {
    ListResources {
        organization_id: String,
    },
    CreateResource {
        organization_id: String,
    },
    MutateResource {
        organization_id: String,
        resource_id: String,
        operation: OrganizationResourceOperation,
    },
    ListIntelligenceProfiles {
        organization_id: String,
    },
}

pub(super) fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let parts = path_parts(path);
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
    {
        if parts[3].eq_ignore_ascii_case("resources") {
            return match method.as_str() {
                "GET" | "HEAD" => Some(Endpoint::ListResources {
                    organization_id: parts[2].clone(),
                }),
                "POST" => Some(Endpoint::CreateResource {
                    organization_id: parts[2].clone(),
                }),
                _ => None,
            };
        }
        if parts[3].eq_ignore_ascii_case("intelligence-profiles")
            && matches!(method.as_str(), "GET" | "HEAD")
        {
            return Some(Endpoint::ListIntelligenceProfiles {
                organization_id: parts[2].clone(),
            });
        }
        return None;
    }
    if parts.len() == 5
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
        && parts[3].eq_ignore_ascii_case("resources")
    {
        let operation = if method.as_str() == "PATCH" {
            OrganizationResourceOperation::Update
        } else if method.as_str() == "DELETE" {
            OrganizationResourceOperation::Delete
        } else {
            return None;
        };
        return Some(Endpoint::MutateResource {
            organization_id: parts[2].clone(),
            resource_id: parts[4].clone(),
            operation,
        });
    }
    if parts.len() < 4
        || !parts[0].eq_ignore_ascii_case("api")
        || !parts[1].eq_ignore_ascii_case("orgs")
        || !parts[3].eq_ignore_ascii_case("resources")
    {
        return None;
    }
    None
}

/// Reserve resource-route aliases before the public compatibility proxy. The
/// existing intelligence-profile PUT subroutes remain Node-owned.
pub(super) fn reserved_path(path: &str) -> bool {
    let parts = path_parts(path);
    if parts.len() >= 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
        && parts[3].eq_ignore_ascii_case("resources")
    {
        return true;
    }
    parts.len() == 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
        && parts[3].eq_ignore_ascii_case("intelligence-profiles")
}

fn path_parts(path: &str) -> Vec<String> {
    let decoded = decode_path(path);
    decoded
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_owned)
        .collect()
}

fn decode_path(path: &str) -> String {
    let mut decoded = path.to_owned();
    for _ in 0..4 {
        let next = percent_encoding::percent_decode_str(&decoded)
            .decode_utf8_lossy()
            .into_owned();
        if next == decoded {
            break;
        }
        decoded = next;
    }
    decoded
}

pub(super) async fn handle(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    endpoint: Endpoint,
) -> HttpResponse {
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    let _admission = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, reason)) => return state.foundation.json_error(status, reason),
    };
    if requires_trusted_board_origin(&identity, &endpoint)
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return HttpResponse::Forbidden()
            .json(json!({"error":crate::local_account_ingress::BOARD_ORIGIN_ERROR}));
    }
    let body = match read_body(
        &mut payload,
        state
            .foundation
            .config
            .max_request_bytes
            .min(MAX_BODY_BYTES),
    )
    .await
    {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let Some((actor, session_id)) = actor_and_session(&identity) else {
        return state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let Some(authorizer) = native_authorizer(&identity, &actor, &session_id, &state) else {
        return state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let organization_id = endpoint_organization_id(&endpoint).to_owned();

    match endpoint {
        Endpoint::ListResources { .. } => {
            let input = OrganizationCatalogReadInput {
                operation: OrganizationCatalogReadOperation::Resources,
                legacy_date_timezone: None,
            };
            catalog_read(&state, &organization_id, &input, &identity, &authorizer).await
        }
        Endpoint::ListIntelligenceProfiles { .. } => {
            if super::project_reads::agent_organization_id(&identity)
                .is_some_and(|agent_org| agent_org != organization_id)
            {
                return super::project_reads::forbidden_response(&identity);
            }
            if actor.kind != "user" {
                return HttpResponse::Forbidden().json(json!({"error":"Board access required"}));
            }
            let input = OrganizationCatalogReadInput {
                operation: OrganizationCatalogReadOperation::IntelligenceProfiles,
                legacy_date_timezone: None,
            };
            catalog_read(&state, &organization_id, &input, &identity, &authorizer).await
        }
        Endpoint::CreateResource { .. } => {
            if actor.kind != "user" {
                return HttpResponse::Forbidden().json(json!({"error":"Board access required"}));
            }
            let data = match parse_json(&request, &body) {
                Ok(Some(value)) if value.is_object() => value,
                Ok(_) => {
                    return HttpResponse::UnprocessableEntity()
                        .json(json!({"error":"Invalid resource"}));
                }
                Err(response) => return response,
            };
            let DatabaseState::Configured(_) = &state.foundation.database else {
                return state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
            };
            let Some(store) = state.foundation.d1_mutations.as_ref() else {
                return state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
            };
            let command = OrganizationResourceCreateCommand {
                organization_id: organization_id.clone(),
                actor_kind: "board".to_owned(),
                actor_id: actor.id.clone(),
                idempotency_key: request_idempotency_key(&request),
                run_id: None,
                data,
            };
            match store
                .organization_resource_create_public(command, &authorizer)
                .await
            {
                Ok(committed) => match committed.receipt.result {
                    ResultState::OrganizationResourceCreated {
                        resource_id,
                        response,
                    } if response.get("id").and_then(Value::as_str)
                        == Some(resource_id.as_str())
                        && response.get("orgId").and_then(Value::as_str)
                            == Some(organization_id.as_str()) =>
                    {
                        HttpResponse::Created().json(response)
                    }
                    _ => state.foundation.json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "mutation_invalid_receipt",
                    ),
                },
                Err(error) => mutation_error(&state, error),
            }
        }
        Endpoint::MutateResource {
            resource_id,
            operation,
            ..
        } => {
            if actor.kind != "user" {
                return HttpResponse::Forbidden().json(json!({"error":"Board access required"}));
            }
            let data = if operation == OrganizationResourceOperation::Delete {
                json!({})
            } else {
                match parse_json(&request, &body) {
                    Ok(Some(value)) if value.is_object() => value,
                    Ok(_) => {
                        return HttpResponse::UnprocessableEntity()
                            .json(json!({"error":"Invalid resource"}));
                    }
                    Err(response) => return response,
                }
            };
            let DatabaseState::Configured(_) = &state.foundation.database else {
                return state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
            };
            let Some(store) = state.foundation.d1_mutations.as_ref() else {
                return state
                    .foundation
                    .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
            };
            let expected_resource_id = resource_id.clone();
            let command = OrganizationResourceCommand {
                organization_id: organization_id.clone(),
                resource_id,
                actor_kind: "board".to_owned(),
                actor_id: actor.id.clone(),
                idempotency_key: request_idempotency_key(&request),
                run_id: None,
                operation,
                data,
            };
            match store
                .organization_resource_mutate_public(command, &authorizer)
                .await
            {
                Ok(committed) => match committed.receipt.result {
                    ResultState::OrganizationResourceMutated {
                        resource_id: persisted_id,
                        response,
                        operation: persisted_operation,
                    } if persisted_id.eq_ignore_ascii_case(&expected_resource_id)
                        && persisted_operation == operation
                        && response
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| id.eq_ignore_ascii_case(&expected_resource_id))
                        && response
                            .get("orgId")
                            .and_then(Value::as_str)
                            .is_some_and(|id| id.eq_ignore_ascii_case(&organization_id)) =>
                    {
                        HttpResponse::Ok().json(response)
                    }
                    _ => state.foundation.json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "mutation_invalid_receipt",
                    ),
                },
                Err(error) => mutation_error(&state, error),
            }
        }
    }
}

fn requires_trusted_board_origin(identity: &NativeIngressIdentity, endpoint: &Endpoint) -> bool {
    matches!(identity, NativeIngressIdentity::Session(_))
        && matches!(
            endpoint,
            Endpoint::CreateResource { .. } | Endpoint::MutateResource { .. }
        )
}

fn endpoint_organization_id(endpoint: &Endpoint) -> &str {
    match endpoint {
        Endpoint::ListResources { organization_id }
        | Endpoint::CreateResource { organization_id }
        | Endpoint::MutateResource {
            organization_id, ..
        }
        | Endpoint::ListIntelligenceProfiles { organization_id } => organization_id,
    }
}

fn actor_and_session(identity: &NativeIngressIdentity) -> Option<(ActorIdentity, String)> {
    match identity {
        NativeIngressIdentity::None => None,
        NativeIngressIdentity::LocalImplicit => Some((
            ActorIdentity::new("user", "local-board").ok()?,
            "local-implicit".to_owned(),
        )),
        NativeIngressIdentity::Session(identity) => Some((
            ActorIdentity::new("user", &identity.user_id).ok()?,
            identity.session_id.clone(),
        )),
        NativeIngressIdentity::BoardKey {
            user_id, key_id, ..
        } => Some((
            ActorIdentity::new("user", user_id).ok()?,
            format!("board-key:{key_id}"),
        )),
        NativeIngressIdentity::AgentKey {
            agent_id, key_id, ..
        } => Some((
            ActorIdentity::new("agent", agent_id).ok()?,
            format!("agent-key:{key_id}"),
        )),
        NativeIngressIdentity::AgentJwt(identity) => Some((
            ActorIdentity::new("agent", &identity.agent_id).ok()?,
            format!("agent-jwt:{}", identity.agent_id),
        )),
    }
}

fn native_authorizer<'a>(
    identity: &'a NativeIngressIdentity,
    actor: &'a ActorIdentity,
    session_id: &'a str,
    state: &'a IngressState,
) -> Option<MemberDirectoryNativeAuth<'a>> {
    match identity {
        NativeIngressIdentity::None => None,
        NativeIngressIdentity::LocalImplicit => Some(MemberDirectoryNativeAuth::LocalImplicit),
        NativeIngressIdentity::Session(identity) => Some(MemberDirectoryNativeAuth::Session {
            identity,
            kind: state
                .config
                .session_auth
                .as_ref()
                .map_or(NativeSessionAuthKind::BetterAuth, |config| config.kind),
        }),
        NativeIngressIdentity::BoardKey { token_hash, .. }
        | NativeIngressIdentity::AgentKey { token_hash, .. } => {
            Some(MemberDirectoryNativeAuth::Bearer {
                actor,
                session_id,
                token_hash,
            })
        }
        NativeIngressIdentity::AgentJwt(identity) => {
            Some(MemberDirectoryNativeAuth::AgentJwt { identity })
        }
    }
}

async fn catalog_read(
    state: &IngressState,
    organization_id: &str,
    input: &OrganizationCatalogReadInput,
    identity: &NativeIngressIdentity,
    authorizer: &dyn NativeAgentAuthorizer,
) -> HttpResponse {
    let DatabaseState::Configured(_) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let Some(store) = state.foundation.d1_mutations.as_ref() else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    match store
        .organization_catalog_read_public(organization_id, input, authorizer)
        .await
    {
        Ok(body) => HttpResponse::Ok()
            .content_type("application/json")
            .body(body),
        Err(PublicOrganizationResourceError::Unauthorized)
        | Err(PublicOrganizationResourceError::Store(StoreError::PublicIdentityUnauthorized))
        | Err(PublicOrganizationResourceError::Catalog(
            OrganizationCatalogReadError::Unauthorized,
        )) => state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
        Err(PublicOrganizationResourceError::Forbidden)
        | Err(PublicOrganizationResourceError::Store(StoreError::PublicIdentityForbidden))
        | Err(PublicOrganizationResourceError::Catalog(OrganizationCatalogReadError::Forbidden)) => {
            super::project_reads::forbidden_response(identity)
        }
        Err(PublicOrganizationResourceError::Catalog(OrganizationCatalogReadError::Store(
            StoreError::InvalidInput,
        ))) => HttpResponse::UnprocessableEntity()
            .json(json!({"error":"Invalid organization catalog request"})),
        Err(_) => state.foundation.json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "organization_catalog_read_failed",
        ),
    }
}

fn mutation_error(state: &IngressState, error: PublicOrganizationResourceError) -> HttpResponse {
    match error {
        PublicOrganizationResourceError::Unauthorized
        | PublicOrganizationResourceError::Store(StoreError::PublicIdentityUnauthorized) => state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
        PublicOrganizationResourceError::Forbidden
        | PublicOrganizationResourceError::Store(StoreError::PublicIdentityForbidden) => {
            HttpResponse::Forbidden().json(json!({"error":"Organization access denied"}))
        }
        PublicOrganizationResourceError::Store(StoreError::NotFound) => {
            HttpResponse::NotFound().json(json!({"error":"Resource not found"}))
        }
        PublicOrganizationResourceError::Store(StoreError::ResourceConflict) => {
            HttpResponse::Conflict()
                .json(json!({"error":"A Library resource already exists for this path."}))
        }
        PublicOrganizationResourceError::Store(StoreError::NotOwned | StoreError::StaleFence) => {
            HttpResponse::Conflict().json(json!({"error":"Resource mutation authority changed"}))
        }
        PublicOrganizationResourceError::Store(
            StoreError::InvalidResource | StoreError::InvalidInput,
        ) => HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid resource"})),
        _ => state.foundation.json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "resource_mutation_failed",
        ),
    }
}

fn request_idempotency_key(request: &HttpRequest) -> String {
    request
        .headers()
        .get("x-rudder-idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

async fn read_body(
    payload: &mut web::Payload,
    max_bytes: usize,
) -> Result<Vec<u8>, Box<HttpResponse>> {
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|_| {
            Box::new(HttpResponse::BadRequest().json(json!({"error":"Invalid request body"})))
        })?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(Box::new(
                HttpResponse::PayloadTooLarge().json(json!({"error":"Request body too large"})),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

// Keep the ready-to-send transport error at this narrow ingress boundary.
#[allow(clippy::result_large_err)]
fn parse_json(request: &HttpRequest, body: &[u8]) -> Result<Option<Value>, HttpResponse> {
    if body.is_empty() {
        return Ok(None);
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            !value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
    {
        return Ok(None);
    }
    serde_json::from_slice(body).map(Some).map_err(|_| {
        HttpResponse::BadRequest()
            .json(json!({"error":"Invalid JSON in request body","code":"BAD_REQUEST"}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_only_the_migrated_catalog_methods_and_reserves_node_resource_aliases() {
        let org = "10000000-0000-4000-8000-000000000001";
        let resource = "20000000-0000-4000-8000-000000000001";
        assert!(matches!(
            endpoint_for_path(&format!("/API/Orgs/{org}/Resources/"), &Method::GET),
            Some(Endpoint::ListResources { .. })
        ));
        assert!(matches!(
            endpoint_for_path(
                &format!("/api/orgs/{org}/resources/{resource}"),
                &Method::PATCH
            ),
            Some(Endpoint::MutateResource {
                operation: OrganizationResourceOperation::Update,
                ..
            })
        ));
        assert!(
            endpoint_for_path(
                &format!("/api/orgs/{org}/resources/{resource}"),
                &Method::POST
            )
            .is_none()
        );
        assert!(reserved_path(&format!(
            "/api/orgs/{org}/resources/{resource}/extra"
        )));
        assert!(reserved_path(&format!(
            "/api/orgs/{org}/intelligence-profiles"
        )));
        assert!(!reserved_path(&format!(
            "/api/orgs/{org}/intelligence-profiles/default"
        )));
        assert!(!reserved_path(&format!(
            "/api/orgs/{org}/intelligence-profiles/default/"
        )));
    }

    #[test]
    fn percent_encoded_resource_namespace_cannot_fall_through_to_node() {
        assert!(reserved_path("/api/orgs/abc/%72esources/%32"));
        assert!(reserved_path("/%61pi/orgs/abc/resources"));
        assert!(endpoint_for_path("/api/orgs/abc/resources/def", &Method::DELETE).is_some());
    }

    #[test]
    fn only_cookie_backed_board_resource_mutations_require_a_trusted_origin() {
        let endpoint = Endpoint::CreateResource {
            organization_id: "org".to_owned(),
        };
        assert!(requires_trusted_board_origin(
            &NativeIngressIdentity::Session(
                crate::native_session_auth::NativeSessionIdentity::fixture()
            ),
            &endpoint,
        ));
        assert!(!requires_trusted_board_origin(
            &NativeIngressIdentity::BoardKey {
                user_id: "user".to_owned(),
                key_id: "key".to_owned(),
                token_hash: "hash".to_owned(),
            },
            &endpoint,
        ));
        assert!(!requires_trusted_board_origin(
            &NativeIngressIdentity::LocalImplicit,
            &endpoint,
        ));
        assert!(!requires_trusted_board_origin(
            &NativeIngressIdentity::Session(
                crate::native_session_auth::NativeSessionIdentity::fixture()
            ),
            &Endpoint::ListResources {
                organization_id: "org".to_owned(),
            },
        ));
    }
}
