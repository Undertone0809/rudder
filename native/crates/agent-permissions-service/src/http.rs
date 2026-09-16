use crate::{AuthenticatedActor, PermissionError, PermissionService, UpdatePermissions};
use actix_web::{HttpMessage, HttpRequest, HttpResponse, Responder, web};
use serde_json::json;

pub fn configure(config: &mut web::ServiceConfig) {
    config.service(
        web::resource("/api/agents/{id}/permissions").route(web::patch().to(patch_permissions)),
    );
}

pub async fn get_permissions(
    request: HttpRequest,
    service: web::Data<PermissionService>,
    id: web::Path<String>,
) -> impl Responder {
    let Some(actor) = request.extensions().get::<AuthenticatedActor>().cloned() else {
        return error(PermissionError::Unauthorized);
    };
    match service.read(&actor, id.into_inner()).await {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(failure) => error(failure),
    }
}

pub async fn patch_permissions(
    request: HttpRequest,
    service: web::Data<PermissionService>,
    id: web::Path<String>,
    update: web::Json<UpdatePermissions>,
) -> impl Responder {
    let Some(actor) = request.extensions().get::<AuthenticatedActor>().cloned() else {
        return error(PermissionError::Unauthorized);
    };
    match service
        .update(&actor, id.into_inner(), update.into_inner())
        .await
    {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(failure) => error(failure),
    }
}

fn error(error: PermissionError) -> HttpResponse {
    match error {
        PermissionError::Unauthorized => {
            HttpResponse::Unauthorized().json(json!({ "error": "Unauthorized" }))
        }
        PermissionError::Forbidden => {
            HttpResponse::Forbidden().json(json!({ "error": "Forbidden" }))
        }
        PermissionError::OnlyCeo => {
            HttpResponse::Forbidden().json(json!({ "error": "Only CEO can manage permissions" }))
        }
        PermissionError::NotFound => {
            HttpResponse::NotFound().json(json!({ "error": "Agent not found" }))
        }
        PermissionError::Database(_) => {
            HttpResponse::InternalServerError().json(json!({ "error": "Internal server error" }))
        }
    }
}
