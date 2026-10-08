//! Signed, fail-closed transport for Rust-owned Goal GET projections.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{
    StoreError,
    goal_reads::{GoalReadError, GoalReadRequest, read_goals},
};

pub const GOAL_READ_ACTION: &str = "goal.read";
fn goal_read_error(status: StatusCode, code: &str) -> HttpResponse {
    let error = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Goal read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Goal reads are unavailable",
        _ => "Internal server error",
    };
    HttpResponse::build(status).json(serde_json::json!({"error":error,"code":code}))
}
pub(super) async fn goal_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .goal_read(&request, org_id.as_str(), body.as_ref())
        .await
}
impl AppState {
    async fn goal_read(&self, request: &HttpRequest, org_id: &str, body: &[u8]) -> HttpResponse {
        match self.verify_actor_envelope(request, org_id, GOAL_READ_ACTION, None, body) {
            Ok(_) => (),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return goal_read_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return goal_read_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        }
        let input = match serde_json::from_slice::<GoalReadRequest>(body) {
            Ok(input) => input,
            Err(_) => {
                return goal_read_error(StatusCode::UNPROCESSABLE_ENTITY, "goal_read_invalid");
            }
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return goal_read_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_goals(pool, org_id, &input).await {
            Ok(response) => HttpResponse::Ok()
                .content_type("application/json")
                .body(response),
            Err(GoalReadError::Cursor) => HttpResponse::BadRequest()
                .json(serde_json::json!({"error":"Invalid Goal history cursor"})),
            Err(GoalReadError::Limit) => HttpResponse::BadRequest()
                .json(serde_json::json!({"error":"Goal history limit must be between 1 and 100"})),
            Err(GoalReadError::Store(StoreError::NotFound)) => {
                HttpResponse::NotFound().json(serde_json::json!({"error":"Goal not found"}))
            }
            Err(GoalReadError::Store(StoreError::InvalidInput)) => {
                goal_read_error(StatusCode::UNPROCESSABLE_ENTITY, "goal_read_invalid")
            }
            Err(_) => goal_read_error(StatusCode::INTERNAL_SERVER_ERROR, "goal_read_failed"),
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
    use actix_web::test::TestRequest;

    const ORG: &str = "10000000-0000-4000-8000-000000000001";
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/goal-reads";
    const KEY: &[u8] = b"synthetic-goal-read-test-key";

    fn body() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"goalId":null,"view":"list"})).unwrap()
    }

    fn signed_request(body: &[u8], field: &str) -> HttpRequest {
        let now = unix_time_seconds();
        let mut envelope = ActorEnvelope::new(
            ActorIdentity::new("user", "synthetic").unwrap(),
            ORG,
            "session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            PATH,
            GOAL_READ_ACTION,
            body,
            "request",
            format!("nonce-{field}"),
            now,
            now + 60,
        )
        .unwrap();
        match field {
            "org" => envelope.organization_id = "10000000-0000-4000-8000-000000000002".to_owned(),
            "action" => envelope.action = "goal.create".to_owned(),
            "method" => envelope.method = "GET".to_owned(),
            "path" => envelope.path = format!("{PATH}?unexpected=true"),
            "request" => envelope.request_id = "other".to_owned(),
            _ => (),
        }
        let envelope = envelope.sign(KEY).unwrap();
        TestRequest::post()
            .uri(PATH)
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope).unwrap(),
            ))
            .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, "request"))
            .to_http_request()
    }

    fn state() -> AppState {
        AppState::new(ServerConfig {
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap()
    }

    #[actix_web::test]
    async fn native_errors_preserve_the_public_error_contract() {
        for (status, message) in [
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Rust Goal reads are unavailable",
            ),
            (StatusCode::UNAUTHORIZED, "Unauthorized"),
        ] {
            let response = goal_read_error(status, "goal_read_failed");
            assert_eq!(response.status(), status);
            let bytes = actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap();
            let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(payload["error"], message);
            assert_eq!(payload["code"], "goal_read_failed");
        }
    }

    #[actix_web::test]
    async fn read_envelope_binds_body_scope_method_path_action_and_request() {
        for field in [
            "org", "action", "method", "path", "request", "view", "goal", "cursor",
        ] {
            let state = state();
            let mut body = body();
            let request = signed_request(&body, field);
            if matches!(field, "view" | "goal" | "cursor") {
                let mut input: serde_json::Value = serde_json::from_slice(&body).unwrap();
                match field {
                    "view" => input["view"] = serde_json::json!("history"),
                    "goal" => {
                        input["goalId"] = serde_json::json!("20000000-0000-4000-8000-000000000001")
                    }
                    _ => input["cursor"] = serde_json::json!("tampered"),
                }
                body = serde_json::to_vec(&input).unwrap();
            }
            assert_eq!(
                state.goal_read(&request, ORG, &body).await.status(),
                StatusCode::UNAUTHORIZED,
                "{field}"
            );
        }
        let state = state();
        let body = body();
        let request = signed_request(&body, "valid");
        // Valid reads reach the DB boundary even with all mutation pilots off.
        assert_eq!(
            state.goal_read(&request, ORG, &body).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.goal_read(&request, ORG, &body).await.status(),
            StatusCode::UNAUTHORIZED,
            "nonce replay"
        );
    }

    #[actix_web::test]
    async fn malformed_signed_read_is_rejected_before_database_or_filesystem_access() {
        for body in [
            br#"{}"#.as_slice(),
            br#"{"goalId":null,"view":"unsupported"}"#,
            br#"{"goalId":null,"view":"list","owner":"rust"}"#,
        ] {
            assert_eq!(
                state()
                    .goal_read(&signed_request(body, "malformed"), ORG, body)
                    .await
                    .status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        let body = body();
        assert_eq!(
            state()
                .goal_read(&TestRequest::post().uri(PATH).to_http_request(), ORG, &body)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
