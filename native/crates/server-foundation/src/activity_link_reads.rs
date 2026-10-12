//! Existing signed-envelope transport for the admitted ActivityLink GET reads.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{
    StoreError,
    activity_link_reads::{
        ActivityLinkReadError, ActivityLinkReadInput, ActivityLinkReadOperation,
        read_activity_links,
    },
};
pub const ACTIVITY_LINK_READ_ACTION: &str = "activity_link.read";
fn error(status: StatusCode, code: &str) -> HttpResponse {
    let message = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid ActivityLink read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust ActivityLink reads are unavailable",
        _ => "Internal server error",
    };
    if status == StatusCode::INTERNAL_SERVER_ERROR {
        HttpResponse::build(status).json(serde_json::json!({"error":message}))
    } else {
        HttpResponse::build(status).json(serde_json::json!({"error":message,"code":code}))
    }
}
pub(super) async fn activity_link_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org: web::Path<String>,
) -> HttpResponse {
    let actor = match state.verify_actor_envelope(
        &request,
        org.as_str(),
        ACTIVITY_LINK_READ_ACTION,
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
    let input = match serde_json::from_slice::<ActivityLinkReadInput>(&body) {
        Ok(input) if input.validate().is_ok() => input,
        _ => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "activity_link_read_invalid",
            );
        }
    };
    let DatabaseState::Configured(pool) = &state.database else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    match read_activity_links(pool,org.as_str(), crate::run_visibility::owner(&actor),&input).await {
        Ok(body)=>HttpResponse::Ok().content_type("application/json").body(body),
        Err(ActivityLinkReadError::Store(StoreError::NotFound))=>HttpResponse::NotFound().json(serde_json::json!({"error":match input.operation {
                    ActivityLinkReadOperation::IssueRuns => "Issue not found",
                    ActivityLinkReadOperation::RunIssues if input.run_alias.as_deref()==Some("heartbeat") => "Heartbeat run not found",
                    _ => "Agent run not found",
                }})),
        Err(ActivityLinkReadError::Store(StoreError::InvalidInput))=>error(StatusCode::UNPROCESSABLE_ENTITY,"activity_link_read_invalid"),
            Err(ActivityLinkReadError::BadRequest(message)) => HttpResponse::BadRequest().json(serde_json::json!({"error":message})),
        Err(_)=>error(StatusCode::INTERNAL_SERVER_ERROR,"activity_link_read_failed"),
    }
}
