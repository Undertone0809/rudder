//! Authenticated transport for Approval, association and label reads. Kept apart
//! from mutation endpoints so legacy ownership flags cannot gate public reads.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{
    StoreError,
    approval_reads::{ApprovalReadError, ApprovalReadInput, ApprovalReadOperation, read_approvals},
};

pub const APPROVAL_READ_ACTION: &str = "approval.read";

fn approval_read_error(status: StatusCode, code: &str) -> HttpResponse {
    // These bytes cross the public API unchanged. Preserve the Node error
    // contract consumed by HTTP/CLI clients instead of a private receipt shape.
    let error = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Approval read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Approval reads are unavailable",
        _ => "Internal server error",
    };
    HttpResponse::build(status).json(serde_json::json!({ "error": error, "code": code }))
}

pub(super) async fn approval_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .approval_read(&request, org_id.as_str(), body.as_ref())
        .await
}

impl AppState {
    async fn approval_read(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        // Authenticate before accepting any filters. The existing verifier
        // binds actor/org/method/path/action/body and consumes the signed nonce.
        match self.verify_actor_envelope(request, org_id, APPROVAL_READ_ACTION, None, body) {
            Ok(_) => (),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return approval_read_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return approval_read_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        }
        let input = match serde_json::from_slice::<ApprovalReadInput>(body) {
            Ok(input) if input.validate().is_ok() => input,
            _ => {
                return approval_read_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "approval_read_invalid",
                );
            }
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return approval_read_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_approvals(pool, org_id, &input).await {
            // Legacy detail payloads and complete attempt arrays may exceed generic
            // receipt caps. Do not truncate them during this compatibility cutover.
            Ok(response) => HttpResponse::Ok()
                .content_type("application/json")
                .body(response),
            Err(ApprovalReadError::Store(StoreError::NotFound)) => {
                HttpResponse::NotFound().json(serde_json::json!({"error": if input.operation == ApprovalReadOperation::IssueApprovals { "Issue not found" } else { "Approval not found" }}))
            }
            Err(ApprovalReadError::Store(StoreError::InvalidInput)) => {
                approval_read_error(StatusCode::UNPROCESSABLE_ENTITY, "approval_read_invalid")
            }
            Err(_) => HttpResponse::InternalServerError().json(serde_json::json!({"error":"Internal server error"})),
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
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/approval-reads";
    const KEY: &[u8] = b"synthetic-request-read-test-key";

    fn body() -> Vec<u8> {
        br#"{"operation":"detail","targetId":"30000000-0000-4000-8000-000000000001"}"#.to_vec()
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
            APPROVAL_READ_ACTION,
            body,
            "request",
            format!("nonce-{field}"),
            now,
            now + 60,
        )
        .unwrap();
        match field {
            "org" => envelope.organization_id = "10000000-0000-4000-8000-000000000002".to_owned(),
            "action" => envelope.action = "request.create".to_owned(),
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
    async fn approval_reads_are_advertised_with_mutation_pilots_disabled() {
        let state = state();
        let bytes = actix_web::body::to_bytes(state.capabilities().into_body())
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            payload["readOnlyAuthorities"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("approval_read"))
        );
    }

    #[actix_web::test]
    async fn native_errors_preserve_the_public_error_contract() {
        for (status, message) in [
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Rust Approval reads are unavailable",
            ),
            (StatusCode::UNAUTHORIZED, "Unauthorized"),
        ] {
            let response = approval_read_error(status, "approval_read_failed");
            assert_eq!(response.status(), status);
            let bytes = actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap();
            let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(payload["error"], message);
            assert_eq!(payload["code"], "approval_read_failed");
        }
    }

    #[actix_web::test]
    async fn read_envelope_binds_body_scope_method_path_action_and_request() {
        for field in [
            "org",
            "action",
            "method",
            "path",
            "request",
            "operation",
            "targetId",
            "status",
            "kind",
            "legacyDateTimezone",
        ] {
            let state = state();
            let mut body = body();
            let request = signed_request(&body, field);
            if matches!(
                field,
                "operation" | "targetId" | "status" | "kind" | "legacyDateTimezone"
            ) {
                let mut input: serde_json::Value = serde_json::from_slice(&body).unwrap();
                input[field] = if field == "operation" {
                    serde_json::json!("block-audit-attempts")
                } else if field == "kind" {
                    serde_json::json!("approval")
                } else if field == "legacyDateTimezone" {
                    serde_json::json!("Pacific/Honolulu")
                } else {
                    serde_json::json!(42)
                };
                body = serde_json::to_vec(&input).unwrap();
            }
            assert_eq!(
                state.approval_read(&request, ORG, &body).await.status(),
                StatusCode::UNAUTHORIZED,
                "{field}"
            );
        }
        let state = state();
        let body = body();
        let request = signed_request(&body, "valid");
        // Valid reads reach the DB boundary even with all mutation pilots off.
        assert_eq!(
            state.approval_read(&request, ORG, &body).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.approval_read(&request, ORG, &body).await.status(),
            StatusCode::UNAUTHORIZED,
            "nonce replay"
        );
    }

    #[actix_web::test]
    async fn malformed_signed_read_is_rejected_before_database_or_filesystem_access() {
        for body in [
            br#"{}"#.as_slice(),
            br#"{"operation":"unknown"}"#,
            br#"{"operation":"list","targetId":"30000000-0000-4000-8000-000000000001"}"#,
            br#"{"operation":"detail"}"#,
            br#"{"operation":"detail","targetId":"id","status":"bogus"}"#,
            br#"{"operation":"list","owner":"rust"}"#,
            br#"{"operation":"list","legacyDateTimezone":""}"#,
        ] {
            assert_eq!(
                state()
                    .approval_read(&signed_request(body, "malformed"), ORG, body)
                    .await
                    .status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        let body = body();
        assert_eq!(
            state()
                .approval_read(&TestRequest::post().uri(PATH).to_http_request(), ORG, &body)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
