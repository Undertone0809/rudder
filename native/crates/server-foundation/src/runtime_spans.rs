//! Signed internal transport only; Rust persistence owns target authorization,
//! immutable identity and all span/locator effects.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::runtime_spans::{self, Error, Request};
use serde_json::json;

pub(super) async fn command(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    // Inspect only the operation tag to select the signed capability. The
    // typed command is decoded after its complete original bytes are verified.
    let action = match serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value["operation"].as_str().map(str::to_owned))
        .as_deref()
    {
        Some("open") => "runtime.span.open",
        Some("bind_locator") => "runtime.span.bind_locator",
        Some("read") => "runtime.span.read",
        Some("read_transcript") => "runtime.span.read_transcript",
        Some("read_message_transcript") => "runtime.span.read_message_transcript",
        Some("read_conversation_messages") => "runtime.span.read_conversation_messages",
        _ => {
            return HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid runtime span operation"}));
        }
    };
    let actor = match state.verify_actor_envelope(&request, &org_id, action, None, &body) {
        Ok(actor) => actor,
        Err(ActorEnvelopeVerificationError::Unconfigured) => {
            return unavailable();
        }
        Err(ActorEnvelopeVerificationError::Invalid) => {
            return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
        }
    };
    let input = match serde_json::from_slice::<Request>(&body) {
        Ok(input) => input,
        Err(_) => {
            return HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid runtime span request"}));
        }
    };
    let DatabaseState::Configured(pool) = &state.database else {
        return unavailable();
    };
    match runtime_spans::execute(pool, &actor, &org_id, &input).await {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(Error::Http(status, message)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        Err(error) => {
            tracing::warn!(error = %error, "Rust runtime span authority failed");
            HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
        }
    }
}

fn unavailable() -> HttpResponse {
    HttpResponse::ServiceUnavailable()
        .json(json!({"error":"Rust runtime span authority is unavailable"}))
}

#[cfg(test)]
mod tests;
