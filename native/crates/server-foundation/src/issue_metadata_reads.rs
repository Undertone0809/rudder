//! Signed read transport for issue metadata; no mutation ownership or fallback.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{
    StoreError,
    issue_metadata_reads::{
        IssueMetadataReadError, IssueMetadataReadInput, IssueMetadataReadOperation,
        read_issue_metadata,
    },
};

pub const ISSUE_METADATA_READ_ACTION: &str = "issue_metadata.read";
fn read_error(status: StatusCode, code: &str) -> HttpResponse {
    let error = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Issue metadata read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Issue metadata reads are unavailable",
        _ => "Internal server error",
    };
    HttpResponse::build(status).json(serde_json::json!({"error":error,"code":code}))
}
pub(super) async fn issue_metadata_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .issue_metadata_read(&request, org_id.as_str(), body.as_ref())
        .await
}
impl AppState {
    async fn issue_metadata_read(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        let actor = match self.verify_actor_envelope(
            request,
            org_id,
            ISSUE_METADATA_READ_ACTION,
            None,
            body,
        ) {
            Ok(actor) => actor,
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return read_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return read_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        };
        let input = match serde_json::from_slice::<IssueMetadataReadInput>(body) {
            Ok(input) if input.validate().is_ok() => input,
            _ => {
                return read_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "issue_metadata_read_invalid",
                );
            }
        };
        let user_id = if input.operation == IssueMetadataReadOperation::Follows {
            if actor.actor().kind != "user" {
                return HttpResponse::Forbidden()
                    .json(serde_json::json!({"error":"Board authentication required"}));
            }
            if input.board_user_context != Some(true) {
                return HttpResponse::Forbidden()
                    .json(serde_json::json!({"error":"Board user context required"}));
            }
            Some(actor.actor().id.as_str())
        } else {
            None
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return read_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_issue_metadata(pool, org_id, &input, user_id).await {
            Ok(response) => HttpResponse::Ok()
                .content_type("application/json")
                .body(response),
            Err(IssueMetadataReadError::Store(StoreError::NotFound)) => {
                HttpResponse::NotFound().json(serde_json::json!({"error":"Issue not found"}))
            }
            Err(IssueMetadataReadError::Store(StoreError::InvalidInput)) => read_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "issue_metadata_read_invalid",
            ),
            Err(_) => read_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "issue_metadata_read_failed",
            ),
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
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/issue-metadata-reads";
    const KEY: &[u8] = b"synthetic-metadata-catalog-key";
    fn new_state() -> AppState {
        AppState::new(ServerConfig {
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap()
    }
    fn request(kind: &str, body: &[u8]) -> HttpRequest {
        let now = unix_time_seconds();
        let envelope = ActorEnvelope::new(
            ActorIdentity::new(kind, "local-board").unwrap(),
            ORG,
            "session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            PATH,
            ISSUE_METADATA_READ_ACTION,
            body,
            "request",
            "nonce",
            now,
            now + 60,
        )
        .unwrap()
        .sign(KEY)
        .unwrap();
        TestRequest::post()
            .uri(PATH)
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope).unwrap(),
            ))
            .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, "request"))
            .to_http_request()
    }
    #[actix_web::test]
    async fn signed_actor_context_precedes_database_availability() {
        for (kind, body, status) in [
            (
                "user",
                br#"{"operation":"follows","boardUserContext":false}"#.as_slice(),
                403,
            ),
            (
                "agent",
                br#"{"operation":"follows","boardUserContext":true}"#.as_slice(),
                403,
            ),
            (
                "user",
                br#"{"operation":"follows","boardUserContext":true}"#.as_slice(),
                503,
            ),
            (
                "user",
                br#"{"operation":"attachments","issueId":"id","boardUserContext":false}"#
                    .as_slice(),
                422,
            ),
            (
                "user",
                br#"{"operation":"follows","userId":"spoof"}"#.as_slice(),
                422,
            ),
        ] {
            let state = new_state();
            let request = request(kind, body);
            assert_eq!(
                state
                    .issue_metadata_read(&request, ORG, body)
                    .await
                    .status()
                    .as_u16(),
                status
            );
        }
    }
    #[actix_web::test]
    async fn read_transport_rejects_tampering_and_replay() {
        let body = br#"{"operation":"follows","boardUserContext":true}"#;
        let state = new_state();
        let request = request("user", body);
        assert_eq!(
            state
                .issue_metadata_read(&request, ORG, body)
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state
                .issue_metadata_read(&request, ORG, body)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let fresh = new_state();
        let altered = request;
        assert_eq!(
            fresh
                .issue_metadata_read(&altered, ORG, b"{}")
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
