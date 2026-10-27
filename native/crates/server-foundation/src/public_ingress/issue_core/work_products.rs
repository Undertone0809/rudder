//! Public Work Product HTTP handlers. Persistence, actor checks, primary-row
//! changes, and activity writes are owned by D1.

use super::*;
use rudder_d1_persistence::issue_work_products::{
    IssueWorkProductWriteActor, IssueWorkProductWriteError,
    create_with_native_auth as create_work_product_with_native_auth,
    delete_with_native_auth as delete_work_product_with_native_auth,
    update_with_native_auth as update_work_product_with_native_auth,
};

#[derive(Clone, Copy)]
enum Operation {
    Create,
    Update,
    Delete,
}

pub(super) async fn create(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    issue_ref: &str,
) -> HttpResponse {
    write(state, request, body, Operation::Create, issue_ref).await
}

pub(super) async fn update(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    work_product_id: &str,
) -> HttpResponse {
    write(state, request, body, Operation::Update, work_product_id).await
}

pub(super) async fn delete(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    work_product_id: &str,
) -> HttpResponse {
    write(state, request, body, Operation::Delete, work_product_id).await
}

async fn write(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    operation: Operation,
    path_id: &str,
) -> HttpResponse {
    let input = if matches!(operation, Operation::Delete) {
        Value::Object(Default::default())
    } else {
        match super::parse_json_object(body) {
            Some(value) => value,
            None => {
                return HttpResponse::BadRequest().json(json!({
                    "error":"Validation error",
                    "details":[{"code":"invalid_type","expected":"object","received":"non-object","path":[],"message":"Expected object"}]
                }));
            }
        }
    };
    let (identity, actor, session_id, run_id) =
        match super::public_issue_actor(&state, &request).await {
            Ok(actor) => actor,
            Err(response) => return response,
        };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = super::configured_pool(&state) else {
        return super::unavailable();
    };
    let actor_agent_id = (actor.kind == "agent").then_some(actor.id.as_str());
    let write_actor = IssueWorkProductWriteActor {
        kind: &actor.kind,
        id: &actor.id,
        org_id: super::actor_org_id(&identity),
        agent_id: actor_agent_id,
        run_id: run_id.as_deref(),
        authorizer: &authorizer,
    };
    let result = match operation {
        Operation::Create => {
            let lookup = match super::resolve_issue_path_reference(
                pool,
                path_id,
                super::actor_org_id(&identity),
                (actor.kind == "user").then_some(actor.id.as_str()),
                matches!(&identity, NativeIngressIdentity::LocalImplicit),
            )
            .await
            {
                Ok(lookup) => lookup,
                Err(error) => {
                    tracing::warn!(error = %error, issue_ref = path_id, "Work Product Issue lookup failed");
                    return super::internal_error();
                }
            };
            let (issue_id, org_id) = match lookup {
                IssuePathLookup::Found { issue_id, org_id } => (issue_id, org_id),
                IssuePathLookup::Missing => return super::not_found("Issue not found"),
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
            create_work_product_with_native_auth(pool, &write_actor, &org_id, &issue_id, &input)
                .await
                .map(|body| (StatusCode::CREATED, body))
        }
        Operation::Update => {
            update_work_product_with_native_auth(pool, &write_actor, path_id, &input)
                .await
                .map(|body| (StatusCode::OK, body))
        }
        Operation::Delete => delete_work_product_with_native_auth(pool, &write_actor, path_id)
            .await
            .map(|body| (StatusCode::OK, body)),
    };
    match result {
        Ok((status, body)) => HttpResponse::build(status).json(body),
        Err(error) => write_error(
            error,
            &actor.kind,
            if matches!(operation, Operation::Create) {
                "Issue not found"
            } else {
                "Work product not found"
            },
        ),
    }
}

fn write_error(
    error: IssueWorkProductWriteError,
    actor_kind: &str,
    missing_message: &str,
) -> HttpResponse {
    match error {
        IssueWorkProductWriteError::Http(status, message) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        IssueWorkProductWriteError::Validation(details) => {
            HttpResponse::BadRequest().json(json!({"error":"Validation error","details":details}))
        }
        IssueWorkProductWriteError::IssueNotFound => super::not_found("Issue not found"),
        IssueWorkProductWriteError::WorkProductNotFound => {
            super::not_found("Work product not found")
        }
        IssueWorkProductWriteError::InvalidReference(field) => HttpResponse::UnprocessableEntity()
            .json(json!({
                "error":"Invalid work product reference",
                "code":"field_reference_error",
                "field":field,
            })),
        IssueWorkProductWriteError::Store(StoreError::NotFound) => {
            super::not_found(missing_message)
        }
        IssueWorkProductWriteError::Store(StoreError::PublicIdentityUnauthorized) => {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        }
        IssueWorkProductWriteError::Store(StoreError::PublicIdentityForbidden) => {
            let message = if actor_kind == "agent" {
                "Agent key cannot access another organization"
            } else {
                "User does not have access to this organization"
            };
            HttpResponse::Forbidden().json(json!({"error":message}))
        }
        IssueWorkProductWriteError::Store(StoreError::InvalidInput) => {
            HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid work product request"}))
        }
        error => {
            tracing::warn!(error = %error, "public Issue Work Product write failed");
            super::internal_error()
        }
    }
}
