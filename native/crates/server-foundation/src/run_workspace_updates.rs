//! Signed transport for ordinary PATCH only. Archive requests remain Node-owned.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::run_workspace_updates::{self, Error, Request};
use serde_json::json;

pub(super) async fn update(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
) -> HttpResponse {
    let actor = match state.verify_actor_envelope(
        &request,
        "run-workspace-ordinary-update",
        "run_workspace.ordinary_update",
        None,
        &body,
    ) {
        Ok(actor) => actor,
        Err(ActorEnvelopeVerificationError::Unconfigured) => {
            return HttpResponse::ServiceUnavailable()
                .json(json!({"error":"Rust run workspace update authority is unavailable"}));
        }
        Err(_) => return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"})),
    };
    let input = match Request::parse(&body) {
        Ok(input) => input,
        Err(_) => {
            return HttpResponse::BadRequest()
                .json(json!({"error":"Invalid run workspace update command"}));
        }
    };
    if let Err(error) = run_workspace_updates::admit(&input) {
        return failure(error);
    }
    let DatabaseState::Configured(pool) = &state.database else {
        return HttpResponse::ServiceUnavailable()
            .json(json!({"error":"Rust run workspace update authority is unavailable"}));
    };
    match run_workspace_updates::execute(pool, &actor, &input).await {
        Ok(body) => HttpResponse::Ok()
            .content_type("application/json; charset=utf-8")
            .body(body),
        Err(error) => failure(error),
    }
}

fn failure(error: Error) -> HttpResponse {
    match error {
        Error::Http(status, message, details) => {
            let mut body = json!({"error":message});
            if let Some(details) = details {
                body["details"] = details;
            }
            HttpResponse::build(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            )
            .json(body)
        }
        error => {
            tracing::warn!(error=?error,"Ordinary run workspace update failed");
            HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ACTOR_ENVELOPE_AUDIENCE, ACTOR_ENVELOPE_HEADER, ACTOR_ENVELOPE_REQUEST_ID_HEADER,
        ActorEnvelope, ActorIdentity, ServerConfig, SigningKey, unix_time_seconds,
    };
    fn state() -> web::Data<AppState> {
        web::Data::new(
            AppState::new(ServerConfig {
                actor_envelope_key: Some(
                    SigningKey::new(b"synthetic-agent-authority-signing-key").unwrap(),
                ),
                ..ServerConfig::default()
            })
            .unwrap(),
        )
    }
    fn request(body: &[u8], kind: &str, path: &str, action: &str) -> HttpRequest {
        let key = SigningKey::new(b"synthetic-agent-authority-signing-key").unwrap();
        let now = unix_time_seconds();
        let envelope = ActorEnvelope::new(
            ActorIdentity::new(
                kind,
                if kind == "anonymous" {
                    "anonymous"
                } else {
                    "synthetic"
                },
            )
            .unwrap(),
            "run-workspace-ordinary-update",
            "synthetic-session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            path,
            action,
            body,
            "synthetic-request",
            "synthetic-nonce",
            now,
            now + 60,
        )
        .unwrap()
        .sign_with_key(&key)
        .unwrap();
        actix_web::test::TestRequest::post()
            .uri(path)
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope).unwrap(),
            ))
            .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, "synthetic-request"))
            .to_http_request()
    }

    #[actix_web::test]
    async fn ordinary_transport_binds_body_and_rejects_archive_before_database_access() {
        let archived =
            br#"{"id":"50000000-0000-4000-8000-000000000001","input":{"status":"archived"}}"#;
        let path = "/internal/run-workspace-ordinary-update";
        let action = "run_workspace.ordinary_update";
        let response = update(
            state(),
            request(archived, "user", path, action),
            web::Bytes::from_static(archived),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let ordinary =
            br#"{"id":"50000000-0000-4000-8000-000000000001","input":{"status":"idle"}}"#;
        let tampered = update(
            state(),
            request(ordinary, "user", path, action),
            web::Bytes::from_static(archived),
        )
        .await;
        assert_eq!(tampered.status(), StatusCode::UNAUTHORIZED);
        let wrong_action = update(
            state(),
            request(ordinary, "user", path, "run_workspace.patch"),
            web::Bytes::from_static(ordinary),
        )
        .await;
        assert_eq!(wrong_action.status(), StatusCode::UNAUTHORIZED);
        let no_database = update(
            state(),
            request(ordinary, "user", path, action),
            web::Bytes::from_static(ordinary),
        )
        .await;
        assert_eq!(no_database.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
