//! Public Issue row lifecycle, metadata reads, and transactional checkout.

use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::{
    StoreError,
    issue_checkout::{IssueCheckoutError, IssueCheckoutRequest, execute_with_native_auth},
    issue_core_reads::{IssueCoreReadError, read_issue_core_with_native_auth},
    issue_core_writes::{
        IssueAssetStorage, IssueCoreWriteActor, IssueCoreWriteError, IssueCoreWriteOperation,
        IssueCoreWriteRequest, apply_issue_core_write,
    },
    issue_metadata_reads::{
        IssueMetadataReadError, IssueMetadataReadInput, IssueMetadataReadOperation,
        read_issue_metadata_with_native_auth,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    Collection {
        organization_id: String,
    },
    Create {
        organization_id: String,
    },
    Reorder {
        organization_id: String,
    },
    Detail {
        issue_id: String,
    },
    Update {
        issue_id: String,
    },
    Delete {
        issue_id: String,
    },
    IssueMetadata {
        issue_id: String,
        operation: IssueMetadataReadOperation,
    },
    Follows {
        organization_id: String,
    },
    Checkout {
        issue_id: String,
    },
}

enum IssuePathLookup {
    Found { issue_id: String, org_id: String },
    Missing,
    Ambiguous,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutBody {
    agent_id: Option<String>,
    expected_statuses: Option<Vec<String>>,
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path, method).is_some()
}

pub(super) fn is_reserved_namespace(path: &str, method: &Method) -> bool {
    endpoint_path_shape(path, method)
}

fn endpoint_path_shape(path: &str, method: &Method) -> bool {
    let Some(path) = path.strip_prefix('/') else {
        return false;
    };
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    // Work-product creation remains a Node-owned operation. Its GET/HEAD
    // metadata routes are dispatched above, and other methods stay reserved.
    if *method == Method::POST
        && matches!(parts.as_slice(), [api, issues, _id, leaf]
            if api.eq_ignore_ascii_case("api")
                && issues.eq_ignore_ascii_case("issues")
                && leaf.eq_ignore_ascii_case("work-products"))
    {
        return false;
    }
    matches!(parts.as_slice(), [api, orgs, _org_id, issues]
        if api.eq_ignore_ascii_case("api") && orgs.eq_ignore_ascii_case("orgs") && issues.eq_ignore_ascii_case("issues"))
        || matches!(parts.as_slice(), [api, orgs, _org_id, issues, leaf]
            if api.eq_ignore_ascii_case("api") && orgs.eq_ignore_ascii_case("orgs") && issues.eq_ignore_ascii_case("issues") && leaf.eq_ignore_ascii_case("reorder"))
        || matches!(parts.as_slice(), [api, issues, _id]
            if api.eq_ignore_ascii_case("api") && issues.eq_ignore_ascii_case("issues"))
        || matches!(parts.as_slice(), [api, issues, _id, leaf]
        if api.eq_ignore_ascii_case("api")
            && issues.eq_ignore_ascii_case("issues")
            && ["attachments", "work-products", "checkout"].iter().any(|candidate| leaf.eq_ignore_ascii_case(candidate)))
        || matches!(parts.as_slice(), [api, orgs, _org_id, issues, follows]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && issues.eq_ignore_ascii_case("issues")
                && follows.eq_ignore_ascii_case("follows"))
}

fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    match (parts.as_slice(), method) {
        ([api, orgs, organization_id, issues], method)
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && issues.eq_ignore_ascii_case("issues")
                && matches!(*method, Method::GET | Method::HEAD) =>
        {
            Some(Endpoint::Collection {
                organization_id: decode_capture(organization_id)?,
            })
        }
        ([api, orgs, organization_id, issues], &Method::POST)
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && issues.eq_ignore_ascii_case("issues") =>
        {
            Some(Endpoint::Create {
                organization_id: decode_capture(organization_id)?,
            })
        }
        ([api, orgs, organization_id, issues, reorder], &Method::POST)
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && issues.eq_ignore_ascii_case("issues")
                && reorder.eq_ignore_ascii_case("reorder") =>
        {
            Some(Endpoint::Reorder {
                organization_id: decode_capture(organization_id)?,
            })
        }
        ([api, issues, issue_id], method)
            if api.eq_ignore_ascii_case("api")
                && issues.eq_ignore_ascii_case("issues")
                && matches!(*method, Method::GET | Method::HEAD) =>
        {
            Some(Endpoint::Detail {
                issue_id: decode_capture(issue_id)?,
            })
        }
        ([api, issues, issue_id], &Method::PATCH)
            if api.eq_ignore_ascii_case("api") && issues.eq_ignore_ascii_case("issues") =>
        {
            Some(Endpoint::Update {
                issue_id: decode_capture(issue_id)?,
            })
        }
        ([api, issues, issue_id], &Method::DELETE)
            if api.eq_ignore_ascii_case("api") && issues.eq_ignore_ascii_case("issues") =>
        {
            Some(Endpoint::Delete {
                issue_id: decode_capture(issue_id)?,
            })
        }
        ([api, issues, issue_id, resource], method)
            if api.eq_ignore_ascii_case("api")
                && issues.eq_ignore_ascii_case("issues")
                && matches!(*method, Method::GET | Method::HEAD)
                && resource.eq_ignore_ascii_case("attachments") =>
        {
            Some(Endpoint::IssueMetadata {
                issue_id: decode_capture(issue_id)?,
                operation: IssueMetadataReadOperation::Attachments,
            })
        }
        ([api, issues, issue_id, resource], method)
            if api.eq_ignore_ascii_case("api")
                && issues.eq_ignore_ascii_case("issues")
                && matches!(*method, Method::GET | Method::HEAD)
                && resource.eq_ignore_ascii_case("work-products") =>
        {
            Some(Endpoint::IssueMetadata {
                issue_id: decode_capture(issue_id)?,
                operation: IssueMetadataReadOperation::WorkProducts,
            })
        }
        ([api, orgs, organization_id, issues, follows], method)
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && issues.eq_ignore_ascii_case("issues")
                && matches!(*method, Method::GET | Method::HEAD)
                && follows.eq_ignore_ascii_case("follows") =>
        {
            Some(Endpoint::Follows {
                organization_id: decode_capture(organization_id)?,
            })
        }
        ([api, issues, issue_id, checkout], &Method::POST)
            if api.eq_ignore_ascii_case("api")
                && issues.eq_ignore_ascii_case("issues")
                && checkout.eq_ignore_ascii_case("checkout") =>
        {
            Some(Endpoint::Checkout {
                issue_id: decode_capture(issue_id)?,
            })
        }
        _ => None,
    }
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
        .filter(|value| !value.is_empty())
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    _proxy: web::Data<PublicIngressProxy>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return HttpResponse::NotFound().json(json!({"error":"Not found"}));
    };
    let body = match read_body(&state, &mut payload).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }

    match endpoint {
        Endpoint::Collection { organization_id } => {
            read_collection(state, request, &organization_id).await
        }
        Endpoint::Create { organization_id } => {
            write_issue(
                state,
                request,
                &body,
                &organization_id,
                IssueCoreWriteOperation::Create,
            )
            .await
        }
        Endpoint::Reorder { organization_id } => {
            write_issue(
                state,
                request,
                &body,
                &organization_id,
                IssueCoreWriteOperation::Reorder,
            )
            .await
        }
        Endpoint::Detail { issue_id } => read_issue(state, request, &issue_id).await,
        Endpoint::Update { issue_id } => {
            write_issue_by_reference(
                state,
                request,
                &body,
                &issue_id,
                IssueCoreWriteOperation::Update,
            )
            .await
        }
        Endpoint::Delete { issue_id } => {
            write_issue_by_reference(
                state,
                request,
                &body,
                &issue_id,
                IssueCoreWriteOperation::Delete,
            )
            .await
        }
        Endpoint::IssueMetadata {
            issue_id,
            operation,
        } => read_metadata(state, request, &issue_id, operation).await,
        Endpoint::Follows { organization_id } => {
            read_follows(state, request, &organization_id).await
        }
        Endpoint::Checkout { issue_id } => checkout(state, request, &body, &issue_id).await,
    }
}

#[allow(clippy::result_large_err)]
async fn read_body(
    state: &IngressState,
    payload: &mut web::Payload,
) -> Result<web::Bytes, HttpResponse> {
    let max_bytes = state
        .foundation
        .config
        .max_request_bytes
        .min(MAX_BODY_BYTES);
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return Err(HttpResponse::BadRequest().json(json!({"error":"Invalid request body"})));
        };
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(
                HttpResponse::PayloadTooLarge().json(json!({"error":"Request body is too large"}))
            );
        }
        body.extend_from_slice(&chunk);
    }
    Ok(web::Bytes::from(body))
}

async fn read_collection(
    state: web::Data<IngressState>,
    request: HttpRequest,
    organization_id: &str,
) -> HttpResponse {
    let Some(org_id) = canonical_org_id(organization_id) else {
        return not_found("Organization not found");
    };
    let (identity, actor, session_id, run_id) = match public_issue_actor(&state, &request).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = configured_pool(&state) else {
        return unavailable();
    };
    let filters = query_value(request.query_string());
    let user_id = (actor.kind == "user").then_some(actor.id.as_str());
    let _ = run_id;
    match read_issue_core_with_native_auth(
        pool,
        &org_id,
        None,
        &filters,
        user_id,
        "/unused",
        &authorizer,
    )
    .await
    {
        Ok(body) => HttpResponse::Ok().json(body),
        Err(error) => issue_core_read_error(error),
    }
}

async fn read_issue(
    state: web::Data<IngressState>,
    request: HttpRequest,
    issue_ref: &str,
) -> HttpResponse {
    let (identity, actor, session_id, run_id) = match public_issue_actor(&state, &request).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = configured_pool(&state) else {
        return unavailable();
    };
    let lookup = match resolve_issue_path_reference(
        pool,
        issue_ref,
        actor_org_id(&identity),
        (actor.kind == "user").then_some(actor.id.as_str()),
        matches!(&identity, NativeIngressIdentity::LocalImplicit),
    )
    .await
    {
        Ok(lookup) => lookup,
        Err(error) => {
            tracing::warn!(error = %error, issue_ref, "Issue detail identity lookup failed");
            return internal_error();
        }
    };
    let (issue_id, org_id) = match lookup {
        IssuePathLookup::Found { issue_id, org_id } => (issue_id, org_id),
        IssuePathLookup::Missing => return not_found("Issue not found"),
        IssuePathLookup::Ambiguous => {
            return HttpResponse::Conflict().json(json!({
                "error":"Issue ID short reference is ambiguous in this organization. Use a longer typed ref."
            }));
        }
        IssuePathLookup::Invalid => {
            return HttpResponse::UnprocessableEntity().json(json!({
                "error":"Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference"
            }));
        }
    };
    let workspace_root = match agent_core::organization_workspace_root(&org_id) {
        Ok(path) => path,
        Err(()) => return internal_error(),
    };
    let filters = Value::Object(Default::default());
    let user_id = (actor.kind == "user").then_some(actor.id.as_str());
    let _ = run_id;
    match read_issue_core_with_native_auth(
        pool,
        &org_id,
        Some(&issue_id),
        &filters,
        user_id,
        &workspace_root,
        &authorizer,
    )
    .await
    {
        Ok(body) => HttpResponse::Ok().json(body),
        Err(error) => issue_core_read_error(error),
    }
}

async fn write_issue(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    organization_id: &str,
    operation: IssueCoreWriteOperation,
) -> HttpResponse {
    execute_issue_write(state, request, body, Some(organization_id), None, operation).await
}

async fn write_issue_by_reference(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    issue_ref: &str,
    operation: IssueCoreWriteOperation,
) -> HttpResponse {
    execute_issue_write(state, request, body, None, Some(issue_ref), operation).await
}

async fn execute_issue_write(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    organization_id: Option<&str>,
    issue_ref: Option<&str>,
    operation: IssueCoreWriteOperation,
) -> HttpResponse {
    let (identity, actor, session_id, run_id) = match public_issue_actor(&state, &request).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if operation == IssueCoreWriteOperation::Reorder && actor.kind != "user" {
        return HttpResponse::Forbidden().json(json!({"error":"Board authentication required"}));
    }
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = configured_pool(&state) else {
        return unavailable();
    };
    let mut resolved_issue_id = None;
    let org_id = if let Some(org_id) = organization_id {
        let Some(org_id) = canonical_org_id(org_id) else {
            return not_found("Organization not found");
        };
        org_id
    } else {
        let Some(issue_ref) = issue_ref else {
            return internal_error();
        };
        let lookup = match resolve_issue_path_reference(
            pool,
            issue_ref,
            actor_org_id(&identity),
            (actor.kind == "user").then_some(actor.id.as_str()),
            matches!(&identity, NativeIngressIdentity::LocalImplicit),
        )
        .await
        {
            Ok(lookup) => lookup,
            Err(error) => {
                tracing::warn!(error = %error, issue_ref, "Issue mutation identity lookup failed");
                return internal_error();
            }
        };
        match lookup {
            IssuePathLookup::Found { issue_id, org_id } => {
                resolved_issue_id = Some(issue_id);
                org_id
            }
            IssuePathLookup::Missing => return not_found("Issue not found"),
            IssuePathLookup::Ambiguous => {
                return HttpResponse::Conflict().json(json!({
                    "error":"Issue ID short reference is ambiguous in this organization. Use a longer typed ref."
                }));
            }
            IssuePathLookup::Invalid => {
                return HttpResponse::UnprocessableEntity().json(json!({
                    "error":"Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference"
                }));
            }
        }
    };
    let input = if operation == IssueCoreWriteOperation::Delete && body.is_empty() {
        json!({})
    } else if let Some(input) = parse_json_object(body) {
        input
    } else {
        return HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid Issue request"}));
    };
    let actor_agent_id = (actor.kind == "agent").then_some(actor.id.as_str());
    let write_actor = IssueCoreWriteActor {
        kind: &actor.kind,
        id: &actor.id,
        agent_id: actor_agent_id,
        run_id: run_id.as_deref(),
        authorizer: &authorizer,
    };
    let write_request = IssueCoreWriteRequest {
        org_id: &org_id,
        operation,
        issue_id: resolved_issue_id.as_deref(),
        input: &input,
    };
    let asset_storage: Option<&dyn IssueAssetStorage> = state
        .config
        .issue_asset_storage
        .as_deref()
        .map(|storage| storage as &dyn IssueAssetStorage);
    match apply_issue_core_write(pool, &write_actor, &write_request, asset_storage).await {
        Ok((status, value)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(value),
        Err(error) => issue_core_write_error(error),
    }
}

#[allow(clippy::result_large_err)]
async fn public_issue_actor(
    state: &IngressState,
    request: &HttpRequest,
) -> Result<(NativeIngressIdentity, ActorIdentity, String, Option<String>), HttpResponse> {
    if state.config.forwarding_policy.identity(request).is_err() {
        return Err(state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity"));
    }
    if state.config.identity_auth.is_none() {
        return Err(state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        ));
    }
    let identity = resolve_public_http_identity(state, request)
        .await
        .map_err(|(status, code)| state.foundation.json_error(status, code))?;
    if let Some(response) = agent_run_context_mismatch_response(request, &identity) {
        return Err(response);
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return Err(HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"})));
    };
    let run_id = checkout_run_id(request, &identity);
    Ok((identity, actor, session_id, run_id))
}

fn query_value(query: &str) -> Value {
    let mut object = serde_json::Map::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let key = key.into_owned();
        let value = value.into_owned();
        let value = match key.as_str() {
            "limit" | "offset" => value
                .parse::<u64>()
                .ok()
                .map_or(Value::String(value), |value| json!(value)),
            "includeAutomationExecutions" => Value::Bool(matches!(value.as_str(), "true" | "1")),
            _ => Value::String(value),
        };
        match object.entry(key) {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(value);
            }
            serde_json::map::Entry::Occupied(mut entry) => {
                if let Value::Array(values) = entry.get_mut() {
                    values.push(value);
                } else {
                    let first = std::mem::replace(entry.get_mut(), Value::Null);
                    *entry.get_mut() = json!([first, value]);
                }
            }
        }
    }
    Value::Object(object)
}

fn canonical_org_id(org_id: &str) -> Option<String> {
    Uuid::parse_str(org_id).ok().map(|id| id.to_string())
}

fn issue_core_read_error(error: IssueCoreReadError) -> HttpResponse {
    match error {
        IssueCoreReadError::Store(StoreError::NotFound) => not_found("Issue not found"),
        IssueCoreReadError::Store(StoreError::PublicIdentityUnauthorized) => {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        }
        IssueCoreReadError::Store(StoreError::PublicIdentityForbidden) => {
            HttpResponse::Forbidden().json(json!({"error":"Forbidden"}))
        }
        IssueCoreReadError::Store(StoreError::InvalidInput)
        | IssueCoreReadError::InvalidReference => {
            HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid Issue request"}))
        }
        IssueCoreReadError::Http(status, message) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        error => {
            tracing::warn!(error = %error, "public Issue read failed");
            internal_error()
        }
    }
}

fn issue_core_write_error(error: IssueCoreWriteError) -> HttpResponse {
    match error {
        IssueCoreWriteError::Http(status, message) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        IssueCoreWriteError::Store(StoreError::NotFound) => not_found("Issue not found"),
        IssueCoreWriteError::Store(StoreError::PublicIdentityUnauthorized) => {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        }
        IssueCoreWriteError::Store(StoreError::PublicIdentityForbidden) => {
            HttpResponse::Forbidden().json(json!({"error":"Forbidden"}))
        }
        IssueCoreWriteError::Store(StoreError::InvalidInput) => {
            HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid Issue request"}))
        }
        error => {
            tracing::warn!(error = %error, "public Issue write failed");
            internal_error()
        }
    }
}

async fn read_metadata(
    state: web::Data<IngressState>,
    request: HttpRequest,
    issue_id: &str,
    operation: IssueMetadataReadOperation,
) -> HttpResponse {
    if Uuid::parse_str(issue_id).is_err() {
        return not_found("Issue not found");
    }
    let Some(pool) = configured_pool(&state) else {
        return unavailable();
    };
    let org_id =
        match sqlx::query_scalar::<_, String>("SELECT org_id::text FROM issues WHERE id=$1::uuid")
            .bind(issue_id)
            .fetch_optional(pool)
            .await
        {
            Ok(Some(org_id)) => org_id,
            Ok(None) => return not_found("Issue not found"),
            Err(error) => {
                tracing::warn!(error = %error, issue_id, "Issue metadata identity lookup failed");
                return internal_error();
            }
        };
    read_metadata_for_identity(
        state,
        request,
        &org_id,
        IssueMetadataReadInput {
            operation,
            issue_id: Some(issue_id.to_owned()),
            board_user_context: None,
            legacy_date_timezone: None,
        },
    )
    .await
}

async fn read_follows(
    state: web::Data<IngressState>,
    request: HttpRequest,
    org_id: &str,
) -> HttpResponse {
    if Uuid::parse_str(org_id).is_err() {
        return not_found("Issue not found");
    }
    read_metadata_for_identity(
        state,
        request,
        org_id,
        IssueMetadataReadInput {
            operation: IssueMetadataReadOperation::Follows,
            issue_id: None,
            board_user_context: Some(true),
            legacy_date_timezone: None,
        },
    )
    .await
}

async fn read_metadata_for_identity(
    state: web::Data<IngressState>,
    request: HttpRequest,
    org_id: &str,
    input: IssueMetadataReadInput,
) -> HttpResponse {
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if matches!(input.operation, IssueMetadataReadOperation::Follows)
        && !matches!(
            identity,
            NativeIngressIdentity::Session(_)
                | NativeIngressIdentity::BoardKey { .. }
                | NativeIngressIdentity::LocalImplicit
        )
    {
        return HttpResponse::Forbidden().json(json!({"error":"Board authentication required"}));
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let user_id = if input.operation == IssueMetadataReadOperation::Follows {
        if actor.kind != "user" {
            return HttpResponse::Forbidden()
                .json(json!({"error":"Board authentication required"}));
        }
        Some(actor.id.as_str())
    } else {
        None
    };
    let Some(pool) = configured_pool(&state) else {
        return unavailable();
    };
    match read_issue_metadata_with_native_auth(pool, org_id, &input, user_id, &authorizer).await {
        Ok(body) => HttpResponse::Ok()
            .content_type("application/json; charset=utf-8")
            .body(body),
        Err(IssueMetadataReadError::Store(StoreError::NotFound)) => not_found("Issue not found"),
        Err(IssueMetadataReadError::Store(StoreError::PublicIdentityUnauthorized)) => {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        }
        Err(IssueMetadataReadError::Store(StoreError::PublicIdentityForbidden)) => {
            HttpResponse::Forbidden().json(json!({"error":"Forbidden"}))
        }
        Err(IssueMetadataReadError::Store(StoreError::InvalidInput)) => {
            HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid Issue metadata request"}))
        }
        Err(error) => {
            tracing::warn!(error = %error, org_id, "Issue metadata read failed");
            internal_error()
        }
    }
}

async fn checkout(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    issue_id: &str,
) -> HttpResponse {
    let Some(value) = parse_json_object(body) else {
        return HttpResponse::UnprocessableEntity()
            .json(json!({"error":"Invalid issue checkout request"}));
    };
    let Some(checkout) = serde_json::from_value::<CheckoutBody>(value).ok() else {
        return HttpResponse::UnprocessableEntity()
            .json(json!({"error":"Invalid issue checkout request"}));
    };
    let (Some(agent_id), Some(expected_statuses)) = (checkout.agent_id, checkout.expected_statuses)
    else {
        return HttpResponse::UnprocessableEntity()
            .json(json!({"error":"Invalid issue checkout request"}));
    };

    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if identity_agent_id(&identity).is_some()
        && matches!(&identity, NativeIngressIdentity::AgentJwt(_))
        && agent_run_id_header(&request).is_none()
    {
        return HttpResponse::Unauthorized().json(json!({"error":"Agent run id required"}));
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = configured_pool(&state) else {
        return unavailable();
    };
    let board_user_id = (actor.kind == "user").then_some(actor.id.as_str());
    let lookup = match resolve_issue_path_reference(
        pool,
        issue_id,
        actor_org_id(&identity),
        board_user_id,
        matches!(&identity, NativeIngressIdentity::LocalImplicit),
    )
    .await
    {
        Ok(lookup) => lookup,
        Err(error) => {
            tracing::warn!(error = %error, issue_id, "Issue checkout identity lookup failed");
            return internal_error();
        }
    };
    let (resolved_issue_id, org_id) = match lookup {
        IssuePathLookup::Found { issue_id, org_id } => (issue_id, org_id),
        IssuePathLookup::Missing => return not_found("Issue not found"),
        IssuePathLookup::Ambiguous => {
            return HttpResponse::Conflict().json(json!({
                "error":"Issue ID short reference is ambiguous in this organization. Use a longer typed ref."
            }));
        }
        IssuePathLookup::Invalid => {
            return HttpResponse::UnprocessableEntity().json(json!({
                "error":"Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference"
            }));
        }
    };
    let input = IssueCheckoutRequest {
        org_id,
        issue_id: resolved_issue_id,
        agent_id,
        expected_statuses,
        actor_run_id: checkout_run_id(&request, &identity),
    };
    match execute_with_native_auth(pool, &actor.kind, &actor.id, &authorizer, &input).await {
        Ok((status, body)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .content_type("application/json; charset=utf-8")
        .body(body),
        Err(IssueCheckoutError::Http(status, message, details)) => {
            let mut value = json!({"error":message});
            if let Some(details) = details {
                value["details"] = details;
            }
            HttpResponse::build(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            )
            .json(value)
        }
        Err(error) => {
            tracing::warn!(error = %error, issue_id, "public Issue checkout failed");
            internal_error()
        }
    }
}

fn parse_json_object(body: &[u8]) -> Option<Value> {
    match serde_json::from_slice::<Value>(body).ok()? {
        Value::Object(value) => Some(Value::Object(value)),
        _ => None,
    }
}

fn identity_agent_id(identity: &NativeIngressIdentity) -> Option<&str> {
    match identity {
        NativeIngressIdentity::AgentKey { agent_id, .. } => Some(agent_id),
        NativeIngressIdentity::AgentJwt(identity) => Some(&identity.agent_id),
        _ => None,
    }
}

fn actor_org_id(identity: &NativeIngressIdentity) -> Option<&str> {
    match identity {
        NativeIngressIdentity::AgentKey { org_id, .. } => Some(org_id),
        NativeIngressIdentity::AgentJwt(identity) => Some(&identity.org_id),
        _ => None,
    }
}

async fn resolve_issue_path_reference(
    pool: &sqlx::PgPool,
    raw: &str,
    scoped_org: Option<&str>,
    board_user_id: Option<&str>,
    allow_all_orgs: bool,
) -> Result<IssuePathLookup, sqlx::Error> {
    let raw = raw.trim();
    if let Ok(id) = Uuid::parse_str(raw) {
        let row = sqlx::query_as::<_, (String, String)>(
            "SELECT id::text,org_id::text FROM issues WHERE id=$1::uuid",
        )
        .bind(id.to_string())
        .fetch_optional(pool)
        .await?;
        return Ok(row.map_or(IssuePathLookup::Missing, |(issue_id, org_id)| {
            IssuePathLookup::Found { issue_id, org_id }
        }));
    }

    if let Some((prefix, number)) = parse_issue_identifier(raw) {
        let exact = sqlx::query_as::<_, (String, String)>(
            "SELECT id::text,org_id::text FROM issues WHERE upper(identifier)=upper($1)",
        )
        .bind(raw)
        .fetch_optional(pool)
        .await?;
        let row = if let Some(row) = exact {
            Some(row)
        } else {
            sqlx::query_as::<_, (String, String)>(
                "SELECT i.id::text,i.org_id::text FROM organization_issue_prefix_aliases a JOIN issues i ON i.org_id=a.org_id AND i.issue_number=$2 WHERE upper(a.prefix)=upper($1)",
            )
            .bind(prefix)
            .bind(number)
            .fetch_optional(pool)
            .await?
        };
        return Ok(row.map_or(IssuePathLookup::Missing, |(issue_id, org_id)| {
            IssuePathLookup::Found { issue_id, org_id }
        }));
    }

    if has_short_reference_prefix(raw) {
        let Some((kind, prefix)) = parse_typed_issue_reference(raw) else {
            return Ok(IssuePathLookup::Invalid);
        };
        if kind != "iss" {
            return Ok(IssuePathLookup::Invalid);
        }
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT i.id::text,i.org_id::text FROM issues i WHERE replace(lower(i.id::text),'-','') LIKE $1 || '%' AND (($2::uuid IS NOT NULL AND i.org_id=$2::uuid) OR ($2::uuid IS NULL AND ($3::boolean OR EXISTS (SELECT 1 FROM organization_memberships m WHERE m.org_id=i.org_id AND m.principal_type='user' AND m.principal_id=$4 AND m.status='active') OR EXISTS (SELECT 1 FROM instance_user_roles r WHERE r.user_id=$4 AND r.role='instance_admin')))) ORDER BY i.id LIMIT 2",
        )
        .bind(prefix)
        .bind(scoped_org)
        .bind(allow_all_orgs)
        .bind(board_user_id.unwrap_or_default())
        .fetch_all(pool)
        .await?;
        return Ok(match rows.as_slice() {
            [(issue_id, org_id)] => IssuePathLookup::Found {
                issue_id: issue_id.clone(),
                org_id: org_id.clone(),
            },
            [] => IssuePathLookup::Missing,
            _ => IssuePathLookup::Ambiguous,
        });
    }

    Ok(IssuePathLookup::Missing)
}

fn parse_issue_identifier(raw: &str) -> Option<(&str, i32)> {
    let (prefix, number) = raw.rsplit_once('-')?;
    let mut characters = prefix.chars();
    if !characters.next()?.is_ascii_alphabetic()
        || !characters.all(|character| character.is_ascii_alphanumeric())
        || number.is_empty()
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((prefix, number.parse().ok()?))
}

fn has_short_reference_prefix(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 4 && bytes[..3].iter().all(u8::is_ascii_alphabetic) && bytes[3] == b'_'
}

fn parse_typed_issue_reference(raw: &str) -> Option<(&str, &str)> {
    let prefix = raw.get(..4)?;
    if prefix.as_bytes()[3] != b'_' {
        return None;
    }
    if !prefix.as_bytes()[..3].iter().all(u8::is_ascii_alphabetic) {
        return None;
    }
    let kind = std::str::from_utf8(&prefix.as_bytes()[..3]).ok()?;
    let id = raw.get(4..)?;
    (8..=32)
        .contains(&id.len())
        .then_some(())
        .filter(|_| id.bytes().all(|byte| byte.is_ascii_hexdigit()))?;
    Some((kind, id))
}

fn checkout_run_id(request: &HttpRequest, identity: &NativeIngressIdentity) -> Option<String> {
    match identity {
        NativeIngressIdentity::AgentJwt(identity) => Some(identity.run_id.clone()),
        NativeIngressIdentity::AgentKey { .. } => agent_run_id_header(request),
        _ => None,
    }
}

fn configured_pool(state: &IngressState) -> Option<&sqlx::PgPool> {
    match &state.foundation.database {
        DatabaseState::Configured(pool) => Some(pool),
        DatabaseState::Disabled => None,
    }
}

fn not_found(message: &str) -> HttpResponse {
    HttpResponse::NotFound().json(json!({"error":message}))
}

fn unavailable() -> HttpResponse {
    HttpResponse::ServiceUnavailable().json(json!({"error":"Rust Issue API is unavailable"}))
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_and_checkout_paths_are_reserved_without_matching_sidecars() {
        for (path, method) in [
            ("/api/issues/abc/attachments", Method::GET),
            ("/api/issues/abc/work-products", Method::GET),
            ("/api/orgs/org-1/issues/follows", Method::GET),
            ("/api/issues/abc/checkout", Method::POST),
        ] {
            assert!(is_reserved_path(path, &method), "{method} {path}");
        }
        assert!(!is_reserved_namespace(
            "/api/issues/abc/comments",
            &Method::GET
        ));
        assert!(!is_reserved_namespace(
            "/api/issues/abc/documents/key",
            &Method::GET
        ));
        assert!(is_reserved_namespace(
            "/api/issues/abc/work-products",
            &Method::GET
        ));
        assert!(is_reserved_namespace(
            "/api/issues/abc/work-products/",
            &Method::HEAD
        ));
        assert!(!is_reserved_path(
            "/api/issues/abc/work-products",
            &Method::POST
        ));
        assert!(!is_reserved_namespace(
            "/api/issues/abc/work-products",
            &Method::POST
        ));
        assert!(is_reserved_namespace(
            "/api/issues/abc/work-products",
            &Method::DELETE
        ));
    }

    #[test]
    fn issue_core_row_lifecycle_paths_are_reserved_for_the_native_authority() {
        for (path, method) in [
            ("/api/orgs/org-1/issues", Method::GET),
            ("/api/orgs/org-1/issues", Method::POST),
            ("/api/orgs/org-1/issues/reorder", Method::POST),
            ("/api/issues/issue-1", Method::GET),
            ("/api/issues/issue-1", Method::PATCH),
            ("/api/issues/issue-1", Method::DELETE),
        ] {
            assert!(is_reserved_path(path, &method), "{method} {path}");
        }
        assert!(is_reserved_namespace(
            "/api/orgs/org-1/issues",
            &Method::GET
        ));
        assert!(is_reserved_namespace("/api/issues/issue-1", &Method::GET));
        assert!(!is_reserved_path(
            "/api/issues/issue-1/comments",
            &Method::GET
        ));
        assert!(!is_reserved_path(
            "/api/orgs/org-1/issues/follows",
            &Method::POST
        ));
    }

    #[test]
    fn issue_path_references_match_legacy_identifier_and_typed_reference_shapes() {
        assert_eq!(
            parse_issue_identifier("oldPrefix-42"),
            Some(("oldPrefix", 42))
        );
        assert_eq!(parse_issue_identifier("not-an-issue"), None);
        assert!(has_short_reference_prefix("iss_abcdef01"));
        assert_eq!(
            parse_typed_issue_reference("iss_abcdef01"),
            Some(("iss", "abcdef01"))
        );
        assert_eq!(
            parse_typed_issue_reference("agt_abcdef01"),
            Some(("agt", "abcdef01"))
        );
        assert!(has_short_reference_prefix("iss_bad"));
        assert_eq!(parse_typed_issue_reference("iss_bad"), None);
        assert!(!has_short_reference_prefix("🔥_abcdef01"));
    }
}
