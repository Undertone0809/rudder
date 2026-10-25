//! Public Project writes use the existing D1 mutation and receipt authority.
//! This module adapts the legacy HTTP shapes; it does not implement Project
//! business rules or fall back to Node when a matched write fails.

use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::{
    ProjectCreateCommand, ProjectDeleteCommand, ProjectPatchCommand, ProjectPatchMutationOrigin,
    ResultState, StoreError,
    agent_core::NativeAgentAuthorizer,
    project_reads::{
        ProjectReferenceResolution, is_project_uuid_like, project_organization_id_in_snapshot,
        read_projects, resolve_project_reference_in_snapshot,
    },
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use uuid::Uuid;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const PROJECT_FIELDS: &[&str] = &[
    "goalId",
    "goalIds",
    "name",
    "description",
    "status",
    "leadAgentId",
    "targetDate",
    "color",
    "icon",
    "executionWorkspacePolicy",
    "resourceAttachments",
    "newResources",
    "archivedAt",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AttachmentOperation {
    Update,
    Remove,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    Create {
        organization_id: String,
    },
    Patch {
        project_ref: String,
    },
    Delete {
        project_ref: String,
    },
    Attach {
        project_ref: String,
    },
    Attachment {
        project_ref: String,
        attachment_id: String,
        operation: AttachmentOperation,
    },
}

pub(super) fn is_reserved_path(path: &str) -> bool {
    let Some(parts) = path_parts(path) else {
        return false;
    };
    (parts.len() == 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
        && parts[3].eq_ignore_ascii_case("projects"))
        || (parts.len() == 3
            && parts[0].eq_ignore_ascii_case("api")
            && parts[1].eq_ignore_ascii_case("projects"))
        || (parts.len() == 4
            && parts[0].eq_ignore_ascii_case("api")
            && parts[1].eq_ignore_ascii_case("projects")
            && parts[3].eq_ignore_ascii_case("resources"))
        || (parts.len() == 5
            && parts[0].eq_ignore_ascii_case("api")
            && parts[1].eq_ignore_ascii_case("projects")
            && parts[3].eq_ignore_ascii_case("resources"))
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return not_found();
    };
    let max_body_bytes = state
        .foundation
        .config
        .max_request_bytes
        .min(MAX_BODY_BYTES);
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len()) > max_body_bytes {
            return HttpResponse::PayloadTooLarge().json(json!({"error":"Request body too large"}));
        }
        body.extend_from_slice(&chunk);
    }
    execute(state, request, web::Bytes::from(body), endpoint).await
}

fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let parts = path_parts(path)?;
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
        && parts[3].eq_ignore_ascii_case("projects")
        && *method == Method::POST
    {
        return Some(Endpoint::Create {
            organization_id: parts[2].clone(),
        });
    }
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("projects")
    {
        return match *method {
            Method::PATCH => Some(Endpoint::Patch {
                project_ref: parts[2].clone(),
            }),
            Method::DELETE => Some(Endpoint::Delete {
                project_ref: parts[2].clone(),
            }),
            _ => None,
        };
    }
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("projects")
        && parts[3].eq_ignore_ascii_case("resources")
        && *method == Method::POST
    {
        return Some(Endpoint::Attach {
            project_ref: parts[2].clone(),
        });
    }
    if parts.len() == 5
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("projects")
        && parts[3].eq_ignore_ascii_case("resources")
    {
        let operation = match *method {
            Method::PATCH => AttachmentOperation::Update,
            Method::DELETE => AttachmentOperation::Remove,
            _ => return None,
        };
        return Some(Endpoint::Attachment {
            project_ref: parts[2].clone(),
            attachment_id: parts[4].clone(),
            operation,
        });
    }
    None
}

fn path_parts(path: &str) -> Option<Vec<String>> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let segments: Vec<_> = path.split('/').collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    segments
        .into_iter()
        .map(|segment| {
            percent_encoding::percent_decode_str(segment)
                .decode_utf8()
                .ok()
                .map(|value| value.into_owned())
        })
        .collect()
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
    if matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return HttpResponse::Forbidden()
            .json(json!({"error":crate::local_account_ingress::BOARD_ORIGIN_ERROR}));
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let Some(store) = state.foundation.d1_mutations.as_ref() else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };

    match endpoint {
        Endpoint::Create { organization_id } => {
            let Some(data) = parse_project_body(&request, &body, false) else {
                return invalid_project();
            };
            let Some(data) = filtered_project_data(data) else {
                return invalid_project();
            };
            let organization_id = match Uuid::parse_str(&organization_id) {
                Ok(id) => id.to_string(),
                Err(_) => return not_found(),
            };
            let workspace_root = match agent_core::organization_workspace_root(&organization_id) {
                Ok(root) => root,
                Err(()) => return unavailable_error("project_library_unavailable"),
            };
            let state_root = match agent_core::project_create_state_root(&organization_id) {
                Ok(root) => root,
                Err(()) => return unavailable_error("project_library_unavailable"),
            };
            let provisioner = ScopedProjectCreateProvisioner {
                organization_workspace_root: PathBuf::from(workspace_root),
                project_create_state_root: PathBuf::from(state_root),
                prepare_workspace_layout: true,
            };
            let command = ProjectCreateCommand {
                organization_id: organization_id.clone(),
                actor_kind: actor_kind(&actor.kind).to_owned(),
                actor_id: actor.id.clone(),
                run_id: identity_run_id(&identity),
                idempotency_key: request_idempotency_key(&request),
                data,
                activity_details: json!({}),
            };
            match store
                .project_create_public(command, &provisioner, &authorizer)
                .await
            {
                Ok(committed) => match committed.receipt.result {
                    ResultState::ProjectCreated {
                        project_id,
                        response,
                    } if response.get("id").and_then(Value::as_str)
                        == Some(project_id.as_str())
                        && response.get("orgId").and_then(Value::as_str)
                            == Some(organization_id.as_str()) =>
                    {
                        HttpResponse::Created().json(response)
                    }
                    _ => mutation_error(&state, StoreError::InvalidReceipt),
                },
                Err(error) => project_write_error(&state, error),
            }
        }
        Endpoint::Patch { project_ref } => {
            let Some(patch) = parse_project_body(&request, &body, false) else {
                return invalid_project();
            };
            let Some(patch) = filtered_project_data(patch) else {
                return invalid_project();
            };
            let (organization_id, project_id) =
                match resolve_project_target(pool, &request, &identity, &authorizer, &project_ref)
                    .await
                {
                    Ok(target) => target,
                    Err(response) => return response,
                };
            let command = ProjectPatchCommand {
                organization_id: organization_id.clone(),
                project_id: project_id.clone(),
                actor_kind: actor_kind(&actor.kind).to_owned(),
                actor_id: actor.id.clone(),
                run_id: identity_run_id(&identity),
                idempotency_key: request_idempotency_key(&request),
                expected_version: 0,
                fence_epoch: 0,
                patch,
                mutation_origin: ProjectPatchMutationOrigin::Standard,
            };
            match store.project_patch_public(command, &authorizer).await {
                Ok(committed) => {
                    if !matches!(&committed.receipt.result, ResultState::ProjectPatch { project_id: result_id, .. } if result_id == &project_id)
                    {
                        return mutation_error(&state, StoreError::InvalidReceipt);
                    }
                    let root = match agent_core::organization_workspace_root(&organization_id) {
                        Ok(root) => root,
                        Err(()) => return unavailable_error("project_read_unavailable"),
                    };
                    match read_projects(pool, &organization_id, Some(&project_id), false, &root)
                        .await
                    {
                        Ok(response) => HttpResponse::Ok().json(response),
                        Err(error) => state.foundation.mutation_error(error),
                    }
                }
                Err(error) => project_write_error(&state, error),
            }
        }
        Endpoint::Delete { project_ref } => {
            let key = request_idempotency_key(&request);
            let target =
                resolve_delete_target(pool, &request, &identity, &authorizer, &project_ref, &key)
                    .await;
            let (organization_id, project_id) = match target {
                Ok(target) => target,
                Err(response) => return response,
            };
            let command = ProjectDeleteCommand {
                organization_id: organization_id.clone(),
                project_id: project_id.clone(),
                actor_kind: actor_kind(&actor.kind).to_owned(),
                actor_id: actor.id.clone(),
                run_id: identity_run_id(&identity),
                idempotency_key: key,
                expected_version: 0,
                fence_epoch: 0,
            };
            match store.project_delete_public(command, &authorizer).await {
                Ok(committed) => match committed.receipt.result {
                    ResultState::ProjectDeleted {
                        project_id: result_id,
                        response,
                    } if result_id == project_id => HttpResponse::Ok().json(response),
                    _ => mutation_error(&state, StoreError::InvalidReceipt),
                },
                Err(error) => state.foundation.mutation_error(error),
            }
        }
        Endpoint::Attach { project_ref } => {
            let Some(data) = parse_project_body(&request, &body, false) else {
                return invalid_project_resource();
            };
            let (organization_id, project_id) =
                match resolve_project_target(pool, &request, &identity, &authorizer, &project_ref)
                    .await
                {
                    Ok(target) => target,
                    Err(response) => return response,
                };
            let operation = attachment_patch("attach", None, data);
            mutate_attachment(
                &state,
                store,
                &authorizer,
                &request,
                &identity,
                &actor,
                organization_id,
                project_id,
                operation,
                true,
            )
            .await
        }
        Endpoint::Attachment {
            project_ref,
            attachment_id,
            operation,
        } => {
            let (organization_id, project_id) =
                match resolve_project_target(pool, &request, &identity, &authorizer, &project_ref)
                    .await
                {
                    Ok(target) => target,
                    Err(response) => return response,
                };
            let data = match operation {
                AttachmentOperation::Remove => json!({}),
                AttachmentOperation::Update => match parse_project_body(&request, &body, true) {
                    Some(data) => data,
                    None => return invalid_project_resource(),
                },
            };
            let operation = match operation {
                AttachmentOperation::Update => {
                    attachment_patch("update", Some(&attachment_id), data)
                }
                AttachmentOperation::Remove => {
                    attachment_patch("remove", Some(&attachment_id), json!({}))
                }
            };
            mutate_attachment(
                &state,
                store,
                &authorizer,
                &request,
                &identity,
                &actor,
                organization_id,
                project_id,
                operation,
                false,
            )
            .await
        }
    }
}

// Keep the transport inputs explicit at this HTTP boundary; the operation
// delegates persistence and authorization to the existing D1 mutation store.
#[allow(clippy::too_many_arguments)]
async fn mutate_attachment(
    state: &IngressState,
    store: &MutationStore,
    authorizer: &dyn NativeAgentAuthorizer,
    request: &HttpRequest,
    identity: &NativeIngressIdentity,
    actor: &ActorIdentity,
    organization_id: String,
    project_id: String,
    patch: Value,
    attach: bool,
) -> HttpResponse {
    let idempotency_key = request_idempotency_key(request);
    let command = ProjectPatchCommand {
        organization_id: organization_id.clone(),
        project_id: project_id.clone(),
        actor_kind: actor_kind(&actor.kind).to_owned(),
        actor_id: actor.id.clone(),
        run_id: identity_run_id(identity),
        idempotency_key: idempotency_key.clone(),
        expected_version: 0,
        fence_epoch: 0,
        patch,
        mutation_origin: ProjectPatchMutationOrigin::Standard,
    };
    match store.project_patch_public(command, authorizer).await {
        Ok(committed) => {
            if !matches!(&committed.receipt.result, ResultState::ProjectPatch { project_id: result_id, .. } if result_id == &project_id)
            {
                return mutation_error(state, StoreError::InvalidReceipt);
            }
            let response = match store
                .project_resource_attachment_response(&organization_id, &idempotency_key)
                .await
            {
                Ok(Some(response)) => response,
                Ok(None) => return mutation_error(state, StoreError::InvalidReceipt),
                Err(error) => return state.foundation.mutation_error(error),
            };
            let status = response.get("status").and_then(Value::as_u64);
            let Some(body) = response.get("body").filter(|body| body.is_object()) else {
                return mutation_error(state, StoreError::InvalidReceipt);
            };
            let expected_status = if attach {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            let response_status = status
                .and_then(|status| u16::try_from(status).ok())
                .and_then(|status| StatusCode::from_u16(status).ok());
            if response_status != Some(expected_status) {
                return mutation_error(state, StoreError::InvalidReceipt);
            }
            HttpResponse::build(expected_status).json(body)
        }
        Err(error) => project_attachment_error(state, error),
    }
}

// Returning HttpResponse preserves the established public status/body mapping.
#[allow(clippy::result_large_err)]
async fn resolve_project_target(
    pool: &PgPool,
    request: &HttpRequest,
    identity: &NativeIngressIdentity,
    authorizer: &dyn NativeAgentAuthorizer,
    project_ref: &str,
) -> Result<(String, String), HttpResponse> {
    resolve_project_target_response(pool, request, identity, authorizer, project_ref).await
}

// Returning HttpResponse preserves the established public status/body mapping.
#[allow(clippy::result_large_err)]
async fn resolve_project_target_response(
    pool: &PgPool,
    request: &HttpRequest,
    identity: &NativeIngressIdentity,
    authorizer: &dyn NativeAgentAuthorizer,
    project_ref: &str,
) -> Result<(String, String), HttpResponse> {
    let mut tx = pool.begin().await.map_err(|_| internal_error())?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(|_| internal_error())?;
    let uuid_ref = is_project_uuid_like(project_ref);
    let org_id = if uuid_ref {
        match project_organization_id_in_snapshot(&mut tx, project_ref).await {
            Ok(Some(org_id)) => org_id,
            Ok(None) => return Err(not_found()),
            Err(_) => return Err(internal_error()),
        }
    } else if let Some(org_id) = query_organization_id(request.query_string()) {
        org_id
    } else if let Some(org_id) = project_reads::agent_organization_id(identity) {
        org_id.to_owned()
    } else {
        return Err(not_found());
    };
    match authorizer.revalidate(&mut tx, &org_id).await {
        Ok(rudder_d1_persistence::agent_core::NativeAgentAccess::Authorized) => (),
        Ok(rudder_d1_persistence::agent_core::NativeAgentAccess::Unauthorized) => {
            return Err(HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"})));
        }
        Ok(rudder_d1_persistence::agent_core::NativeAgentAccess::Forbidden) => {
            return Err(project_reads::forbidden_response(identity));
        }
        Err(_) => return Err(internal_error()),
    }
    let project_id = if uuid_ref {
        project_ref.to_ascii_lowercase()
    } else {
        match resolve_project_reference_in_snapshot(&mut tx, &org_id, project_ref).await {
            Ok(ProjectReferenceResolution::Found(project_id)) => project_id,
            Ok(ProjectReferenceResolution::NotFound) => return Err(not_found()),
            Ok(ProjectReferenceResolution::Ambiguous) => {
                return Err(HttpResponse::Conflict().json(json!({
                    "error":"Project shortname is ambiguous in this organization. Use the project ID."
                })));
            }
            Err(_) => return Err(internal_error()),
        }
    };
    tx.commit().await.map_err(|_| internal_error())?;
    Ok((org_id, project_id))
}

// Returning HttpResponse preserves the established public status/body mapping.
#[allow(clippy::result_large_err)]
async fn resolve_delete_target(
    pool: &PgPool,
    request: &HttpRequest,
    identity: &NativeIngressIdentity,
    authorizer: &dyn NativeAgentAuthorizer,
    project_ref: &str,
    idempotency_key: &str,
) -> Result<(String, String), HttpResponse> {
    if is_project_uuid_like(project_ref) {
        let receipt_org_id = sqlx::query_scalar::<_, String>(
            "SELECT org_id::text
             FROM organization_mutation_receipts
             WHERE command_kind='project_delete'
               AND idempotency_key=$1
               AND result->'result'->>'project_id'=$2
             LIMIT 2",
        )
        .bind(idempotency_key)
        .bind(project_ref.to_ascii_lowercase())
        .fetch_all(pool)
        .await
        .map_err(|_| internal_error())?;
        let unique: std::collections::HashSet<_> = receipt_org_id.into_iter().collect();
        if unique.len() > 1 {
            return Err(HttpResponse::Conflict()
                .json(json!({"error":"Project deletion receipt scope is ambiguous"})));
        }
        if let Some(org_id) = unique.into_iter().next() {
            let mut tx = pool.begin().await.map_err(|_| internal_error())?;
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .execute(&mut *tx)
                .await
                .map_err(|_| internal_error())?;
            match authorizer.revalidate(&mut tx, &org_id).await {
                Ok(rudder_d1_persistence::agent_core::NativeAgentAccess::Authorized) => (),
                Ok(rudder_d1_persistence::agent_core::NativeAgentAccess::Unauthorized) => {
                    return Err(HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"})));
                }
                Ok(rudder_d1_persistence::agent_core::NativeAgentAccess::Forbidden) => {
                    return Err(project_reads::forbidden_response(identity));
                }
                Err(_) => return Err(internal_error()),
            }
            tx.commit().await.map_err(|_| internal_error())?;
            return Ok((org_id, project_ref.to_ascii_lowercase()));
        }
    }
    resolve_project_target_response(pool, request, identity, authorizer, project_ref).await
}

fn parse_project_body(request: &HttpRequest, body: &[u8], allow_empty: bool) -> Option<Value> {
    if body.is_empty() {
        return allow_empty.then(|| json!({}));
    }
    let is_json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    if !is_json {
        return allow_empty.then(|| json!({}));
    }
    serde_json::from_slice(body).ok().filter(Value::is_object)
}

fn filtered_project_data(value: Value) -> Option<Value> {
    let Value::Object(object) = value else {
        return None;
    };
    let fields = object
        .into_iter()
        .filter(|(key, _)| PROJECT_FIELDS.contains(&key.as_str()))
        .collect::<Map<_, _>>();
    Some(Value::Object(fields))
}

fn attachment_patch(kind: &str, attachment_id: Option<&str>, data: Value) -> Value {
    let mut operation = Map::new();
    operation.insert("kind".to_owned(), json!(kind));
    if let Some(attachment_id) = attachment_id {
        operation.insert("attachmentId".to_owned(), json!(attachment_id));
    }
    if let Value::Object(data) = data {
        operation.extend(data);
    }
    json!({"resourceAttachmentOperation": operation})
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

fn identity_run_id(identity: &NativeIngressIdentity) -> Option<String> {
    match identity {
        NativeIngressIdentity::AgentJwt(identity) => Some(identity.run_id.clone()),
        _ => None,
    }
}

fn actor_kind(kind: &str) -> &'static str {
    if kind == "user" { "board" } else { "agent" }
}

fn query_organization_id(query: &str) -> Option<String> {
    let mut values = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == "orgId")
        .map(|(_, value)| value.into_owned());
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn mutation_error(state: &IngressState, error: StoreError) -> HttpResponse {
    state.foundation.mutation_error(error)
}

fn project_write_error(state: &IngressState, error: StoreError) -> HttpResponse {
    match error {
        StoreError::InvalidInput | StoreError::InvalidResource => invalid_project(),
        error => state.foundation.mutation_error(error),
    }
}

fn project_attachment_error(state: &IngressState, error: StoreError) -> HttpResponse {
    match error {
        StoreError::InvalidInput | StoreError::InvalidResource => invalid_project_resource(),
        error => state.foundation.mutation_error(error),
    }
}

fn not_found() -> HttpResponse {
    HttpResponse::NotFound().json(json!({"error":"Project not found"}))
}

fn invalid_project() -> HttpResponse {
    HttpResponse::BadRequest().json(json!({"error":"Invalid project"}))
}

fn invalid_project_resource() -> HttpResponse {
    HttpResponse::BadRequest().json(json!({"error":"Invalid project resource attachment"}))
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}

fn unavailable_error(code: &'static str) -> HttpResponse {
    HttpResponse::ServiceUnavailable()
        .json(json!({"error":"Project service unavailable","code":code}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_write_routes_are_native_and_reserved() {
        let cases = [
            ("/api/orgs/org-1/projects", Method::POST, true, true),
            ("/API/ORGS/org-1/PROJECTS/", Method::POST, true, true),
            ("/api/projects/prj_12345678", Method::PATCH, true, true),
            ("/api/projects/prj_12345678/", Method::DELETE, true, true),
            (
                "/api/projects/prj_12345678/resources",
                Method::POST,
                true,
                true,
            ),
            (
                "/api/projects/prj_12345678/resources/att-1",
                Method::PATCH,
                true,
                true,
            ),
            (
                "/api/projects/prj_12345678/resources/att-1",
                Method::DELETE,
                true,
                true,
            ),
            (
                "/api/projects/prj_12345678/resources",
                Method::GET,
                false,
                true,
            ),
            (
                "/api/projects/prj_12345678/other",
                Method::DELETE,
                false,
                false,
            ),
            ("/api/projects//resources", Method::POST, false, false),
        ];
        for (path, method, expected_endpoint, expected_reserved) in cases {
            assert_eq!(is_reserved_path(path), expected_reserved, "{method} {path}");
            assert_eq!(
                endpoint_for_path(path, &method).is_some(),
                expected_endpoint,
                "{method} {path}"
            );
        }
    }

    #[test]
    fn public_project_body_strips_unknown_legacy_workspace_fields() {
        let input = json!({"name":"Project","workspace":{"cwd":"ignored"},"unknown":true});
        let filtered = filtered_project_data(input).unwrap();
        assert_eq!(filtered, json!({"name":"Project"}));
    }
}
