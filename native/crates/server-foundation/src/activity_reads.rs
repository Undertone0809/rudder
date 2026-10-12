//! Signed Activity reads use the existing actor envelope, independently of
//! mutation pilots. Successful responses are public JSON, never receipts.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{
    StoreError,
    activity_reads::{ActivityReadInput, read_activity},
};

pub const ACTIVITY_READ_ACTION: &str = "activity.read";

fn error(status: StatusCode, code: &str) -> HttpResponse {
    let message = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Activity read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Activity reads are unavailable",
        _ => "Internal server error",
    };
    HttpResponse::build(status).json(serde_json::json!({"error":message,"code":code}))
}

pub(super) async fn activity_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .activity_read(&request, org_id.as_str(), body.as_ref())
        .await
}

impl AppState {
    async fn activity_read(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        match self.verify_actor_envelope(request, org_id, ACTIVITY_READ_ACTION, None, body) {
            Ok(_) => (),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        }
        let input = match serde_json::from_slice::<ActivityReadInput>(body) {
            Ok(input) if input.validate().is_ok() => input,
            _ => return error(StatusCode::UNPROCESSABLE_ENTITY, "activity_read_invalid"),
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_activity(pool, org_id, &input).await {
            Ok(response) => HttpResponse::Ok()
                .content_type("application/json")
                .body(response),
            Err(StoreError::InvalidInput) => {
                error(StatusCode::UNPROCESSABLE_ENTITY, "activity_read_invalid")
            }
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "activity_read_failed"),
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
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/activity-reads";
    const KEY: &[u8] = b"synthetic-activity-read-test-key";
    fn state() -> AppState {
        AppState::new(ServerConfig {
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap()
    }
    fn signed(body: &[u8], field: &str) -> HttpRequest {
        let now = unix_time_seconds();
        let mut envelope = ActorEnvelope::new(
            ActorIdentity::new("user", "synthetic").unwrap(),
            ORG,
            "session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            PATH,
            ACTIVITY_READ_ACTION,
            body,
            "request",
            format!("nonce-{field}"),
            now,
            now + 60,
        )
        .unwrap();
        match field {
            "org" => envelope.organization_id = "10000000-0000-4000-8000-000000000002".into(),
            "action" => envelope.action = "cost.read".into(),
            "method" => envelope.method = "GET".into(),
            "path" => envelope.path = format!("{PATH}?extra=true"),
            "request" => envelope.request_id = "other".into(),
            _ => (),
        }
        TestRequest::post()
            .uri(PATH)
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope.sign(KEY).unwrap()).unwrap(),
            ))
            .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, "request"))
            .to_http_request()
    }
    #[actix_web::test]
    async fn envelope_binds_scope_operation_filters_body_and_nonce() {
        for field in [
            "org",
            "action",
            "method",
            "path",
            "request",
            "operation",
            "issueId",
            "cursor",
            "agentId",
            "legacyDateTimezone",
        ] {
            let state = state();
            let original = br#"{"operation":"list"}"#;
            let request = signed(original, field);
            let body = if [
                "operation",
                "issueId",
                "cursor",
                "agentId",
                "legacyDateTimezone",
            ]
            .contains(&field)
            {
                serde_json::to_vec(&serde_json::json!({"operation":"list",(field):"tampered"}))
                    .unwrap()
            } else {
                original.to_vec()
            };
            assert_eq!(
                state.activity_read(&request, ORG, &body).await.status(),
                StatusCode::UNAUTHORIZED,
                "{field}"
            );
        }
        let state = state();
        let body = br#"{"operation":"list"}"#;
        let request = signed(body, "valid");
        assert_eq!(
            state.activity_read(&request, ORG, body).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.activity_read(&request, ORG, body).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[actix_web::test]
    async fn malformed_signed_input_fails_before_database_and_mutation_flags() {
        for body in [
            r#"{}"#,
            r#"{"operation":"unknown"}"#,
            r#"{"operation":"list","owner":"rust"}"#,
            r#"{"operation":"issue"}"#,
            r#"{"operation":"list-page","limit":101}"#,
            r#"{"operation":"list","issueId":"10000000-0000-4000-8000-000000000001"}"#,
        ] {
            assert_eq!(
                state()
                    .activity_read(&signed(body.as_bytes(), "invalid"), ORG, body.as_bytes())
                    .await
                    .status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        let state = state();
        let payload = actix_web::body::to_bytes(state.capabilities().into_body())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert!(
            value["readOnlyAuthorities"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("activity_read"))
        );
        assert_eq!(
            state
                .activity_read(&TestRequest::post().uri(PATH).to_http_request(), ORG, b"{}")
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
