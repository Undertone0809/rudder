//! Existing signed-envelope transport for the admitted Automation GET reads.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{
    StoreError,
    automation_reads::{AutomationReadError, AutomationReadInput, read_automations},
};
pub const AUTOMATION_READ_ACTION: &str = "automation.read";
fn error(status: StatusCode, code: &str) -> HttpResponse {
    let message = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Automation read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Automation reads are unavailable",
        _ => "Internal server error",
    };
    if status == StatusCode::INTERNAL_SERVER_ERROR {
        HttpResponse::build(status).json(serde_json::json!({"error":message}))
    } else {
        HttpResponse::build(status).json(serde_json::json!({"error":message,"code":code}))
    }
}
pub(super) async fn automation_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org: web::Path<String>,
) -> HttpResponse {
    let actor = match state.verify_actor_envelope(
        &request,
        org.as_str(),
        AUTOMATION_READ_ACTION,
        None,
        body.as_ref(),
    ) {
        Ok(actor) => actor,
        Err(ActorEnvelopeVerificationError::Unconfigured) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "actor_envelope_unconfigured",
            );
        }
        Err(ActorEnvelopeVerificationError::Invalid) => {
            return error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
        }
    };
    let input = match serde_json::from_slice::<AutomationReadInput>(&body) {
        Ok(input) if input.validate().is_ok() => input,
        _ => return error(StatusCode::UNPROCESSABLE_ENTITY, "automation_read_invalid"),
    };
    let DatabaseState::Configured(pool) = &state.database else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    match read_automations(
        pool,
        org.as_str(),
        crate::run_visibility::owner(&actor),
        &input,
    )
    .await
    {
        Ok(body) => HttpResponse::Ok()
            .content_type("application/json")
            .body(body),
        Err(AutomationReadError::Store(StoreError::NotFound)) => {
            HttpResponse::NotFound().json(serde_json::json!({"error":"Automation not found"}))
        }
        Err(AutomationReadError::Store(StoreError::InvalidInput)) => {
            error(StatusCode::UNPROCESSABLE_ENTITY, "automation_read_invalid")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "automation_read_failed"),
    }
}
