//! Signed, fail-closed transport for public organization Secret operations.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::secrets::{SecretsError, database_unavailable, execute_secrets};
use serde_json::Value;

pub const SECRETS_ACTION: &str = "secrets.mutate";

pub(super) async fn secrets(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .secrets(&request, org_id.as_str(), body.as_ref())
        .await
}

impl AppState {
    async fn secrets(&self, request: &HttpRequest, org_id: &str, body: &[u8]) -> HttpResponse {
        let actor = match self.verify_actor_envelope(request, org_id, SECRETS_ACTION, None, body) {
            Ok(actor) if actor.actor().kind == "user" => actor,
            Ok(_) => return secrets_error(StatusCode::FORBIDDEN, "Board access required"),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return secrets_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Rust Secrets is unavailable",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return secrets_error(StatusCode::UNAUTHORIZED, "Unauthorized");
            }
        };
        let input = match serde_json::from_slice::<Value>(body) {
            Ok(input) if input.is_object() => input,
            _ => return secrets_error(StatusCode::BAD_REQUEST, "Invalid secrets request"),
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return secrets_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Rust Secrets is unavailable",
            );
        };
        match execute_secrets(pool, org_id, &actor.actor().id, &input).await {
            Ok((status, body)) => {
                let status =
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                HttpResponse::build(status)
                    .content_type("application/json; charset=utf-8")
                    .json(body)
            }
            Err(SecretsError::Http(status, message)) => {
                let status =
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                secrets_error(status, &message)
            }
            Err(SecretsError::Database(error)) if database_unavailable(&error) => {
                tracing::warn!("native Secrets database unavailable");
                secrets_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Rust Secrets is unavailable",
                )
            }
            Err(SecretsError::Database(_error)) => {
                tracing::warn!("native Secrets database operation failed");
                secrets_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        }
    }
}

fn secrets_error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("application/json; charset=utf-8")
        .json(serde_json::json!({"error":message}))
}
