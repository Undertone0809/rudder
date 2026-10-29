//! Temporary signed transport for unchanged legacy LiveEvent frames.
use super::{FORWARD_ACTION, FORWARD_ACTOR, LiveEvent, LiveEventError, LiveEventPublisher};
use crate::{ActorEnvelopeVerificationError, AppState};
use actix_web::{HttpRequest, HttpResponse, web};
use serde_json::json;
#[cfg(test)]
#[path = "forward_tests.rs"]
mod tests;
pub(crate) async fn forward_handler(
    state: web::Data<AppState>,
    publisher: web::Data<LiveEventPublisher>,
    request: HttpRequest,
    body: web::Bytes,
) -> HttpResponse {
    let frame = match serde_json::from_slice::<LiveEvent>(&body) {
        Ok(frame) => frame,
        Err(_) => {
            return HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid live event frame"}));
        }
    };
    let actor =
        match state.verify_actor_envelope(&request, &frame.org_id, FORWARD_ACTION, None, &body) {
            Ok(actor) => actor,
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return HttpResponse::ServiceUnavailable()
                    .json(json!({"error":"Live event transport is unavailable"}));
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return HttpResponse::Unauthorized()
                    .json(json!({"error":"Invalid live event transport signature"}));
            }
        };
    if actor.actor().kind != "system" || actor.actor().id != FORWARD_ACTOR {
        return HttpResponse::Forbidden()
            .json(json!({"error":"Live event transport actor is not authorized"}));
    }
    match publisher.forward_existing(frame) {
        Ok(frame) => HttpResponse::Ok().json(json!({"ok":true,"id":frame.id})),
        Err(LiveEventError::Closed) => HttpResponse::ServiceUnavailable()
            .json(json!({"error":"Live event transport is closed"})),
        Err(_) => {
            HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid live event frame"}))
        }
    }
}
