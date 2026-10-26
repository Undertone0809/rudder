//! Signed internal transport for Issue checkout mutations.

use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::issue_checkout::{IssueCheckoutError, IssueCheckoutRequest, execute};
use serde_json::json;

pub const ISSUE_CHECKOUT_ACTION: &str = "issue.checkout";

pub(super) async fn issue_checkout(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .issue_checkout(&request, org_id.as_str(), body.as_ref())
        .await
}

impl AppState {
    async fn issue_checkout(&self, request: &HttpRequest, org: &str, body: &[u8]) -> HttpResponse {
        let actor =
            match self.verify_actor_envelope(request, org, ISSUE_CHECKOUT_ACTION, None, body) {
                Ok(actor) if matches!(actor.actor().kind.as_str(), "agent" | "user") => actor,
                Ok(_) => {
                    return issue_error(
                        StatusCode::FORBIDDEN,
                        "Agent or Board authentication required",
                    );
                }
                Err(ActorEnvelopeVerificationError::Unconfigured) => {
                    return issue_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Rust Issue checkout is unavailable",
                    );
                }
                Err(ActorEnvelopeVerificationError::Invalid) => {
                    return issue_error(StatusCode::UNAUTHORIZED, "Unauthorized");
                }
            };
        let input = match serde_json::from_slice::<IssueCheckoutRequest>(body) {
            Ok(input) if input.org_id == org => input,
            _ => {
                return issue_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Invalid issue checkout request",
                );
            }
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return issue_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Rust Issue checkout is unavailable",
            );
        };
        match execute(pool, &actor, &input).await {
            Ok((status, body)) => HttpResponse::build(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            )
            .content_type("application/json; charset=utf-8")
            .body(body),
            Err(IssueCheckoutError::Http(status, message, details)) => {
                let mut value = json!({"error": message});
                if let Some(details) = details {
                    value["details"] = details;
                }
                HttpResponse::build(
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                )
                .content_type("application/json; charset=utf-8")
                .json(value)
            }
            Err(IssueCheckoutError::Database(error)) => {
                tracing::warn!(error = %error, "native Issue checkout failed");
                issue_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
            Err(IssueCheckoutError::Json(error)) => {
                tracing::warn!(error = %error, "native Issue checkout response failed");
                issue_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        }
    }
}

fn issue_error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("application/json; charset=utf-8")
        .json(json!({"error": message}))
}
