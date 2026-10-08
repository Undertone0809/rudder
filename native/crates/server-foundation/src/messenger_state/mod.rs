//! Private board-user state authority. All placement mutations share the legacy
//! owner-before-group advisory-lock order, including Node's source cleanup.
mod audit;
mod groups;
mod keep;
mod protocol;
mod saved_views;
mod store;
#[cfg(test)]
mod tests;
mod threads;

use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use protocol::{Command, Request};
use store::{Error, Scope};

pub const MESSENGER_STATE_ACTION: &str = "messenger.state";

pub(super) async fn messenger_state(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state.messenger_state(&request, &org_id, &body).await
}

impl AppState {
    async fn messenger_state(&self, request: &HttpRequest, org: &str, body: &[u8]) -> HttpResponse {
        let actor =
            match self.verify_actor_envelope(request, org, MESSENGER_STATE_ACTION, None, body) {
                Ok(actor) if actor.actor().kind == "user" => actor,
                Ok(_) => return error_response(Error::Http(403, "Board access required")),
                Err(ActorEnvelopeVerificationError::Unconfigured) => {
                    return error_response(Error::Http(503, "Rust Messenger state is unavailable"));
                }
                Err(ActorEnvelopeVerificationError::Invalid) => {
                    return error_response(Error::Http(401, "Unauthorized"));
                }
            };
        let input = match serde_json::from_slice::<Request>(body) {
            Ok(input) if input.validate() => input,
            _ => return error_response(Error::Http(422, "Invalid Messenger state request")),
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return error_response(Error::Http(503, "Rust Messenger state is unavailable"));
        };
        // UUID canonicalization is required for the lock key as well as SQL.
        let org = match uuid::Uuid::parse_str(org) {
            Ok(org) => org.to_string(),
            Err(_) => return error_response(Error::Http(422, "Invalid organization id")),
        };
        let scope = Scope {
            org: &org,
            user: &actor.actor().id,
            audit: &input.audit_context,
        };
        let status = if matches!(
            input.input,
            Command::SavedViewKeep { .. } | Command::GroupCreate { .. }
        ) {
            201
        } else {
            200
        };
        let result = match &input.input {
            Command::SavedViewList { query } => saved_views::list(pool, &scope, query).await,
            Command::SavedViewGet { id } => saved_views::get(pool, &scope, id).await,
            command => store::mutate(pool, &scope, command).await,
        };
        match result {
            Ok(body) => HttpResponse::build(StatusCode::from_u16(status).unwrap())
                .content_type("application/json; charset=utf-8")
                .body(body),
            Err(error) => error_response(error),
        }
    }
}

fn error_response(error: Error) -> HttpResponse {
    let (status, message) = match error {
        Error::Http(status, message) => (status, message),
        Error::Database(error) => {
            tracing::warn!(error = %error, "native Messenger state failed");
            (500, "Internal server error")
        }
        Error::Json(error) => {
            tracing::warn!(error = %error, "native Messenger projection failed");
            (500, "Internal server error")
        }
    };
    HttpResponse::build(StatusCode::from_u16(status).unwrap())
        .content_type("application/json; charset=utf-8")
        .json(serde_json::json!({"error": message}))
}
