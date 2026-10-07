//! Authenticated private transport for the Project read capability. Kept apart
//! from mutation endpoints so legacy ownership flags cannot gate public reads.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState, trusted_absolute_path};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{StoreError, project_reads::read_projects};
use serde::Deserialize;

pub const PROJECT_READ_ACTION: &str = "project.read";

fn project_read_error(status: StatusCode, code: &str) -> HttpResponse {
    // These bytes cross the public API unchanged. Preserve the Node error
    // contract consumed by HTTP/CLI clients instead of a private receipt shape.
    let error = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Project read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Project reads are unavailable",
        _ => "Internal server error",
    };
    HttpResponse::build(status).json(serde_json::json!({ "error": error, "code": code }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProjectReadRequest {
    #[serde(deserialize_with = "deserialize_required_project_id")]
    project_id: Option<String>,
    resources_only: bool,
    organization_workspace_root: String,
}

fn deserialize_required_project_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

pub(super) async fn project_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .project_read(&request, org_id.as_str(), body.as_ref())
        .await
}

impl AppState {
    async fn project_read(&self, request: &HttpRequest, org_id: &str, body: &[u8]) -> HttpResponse {
        // Authenticate before using the host-derived root. The existing verifier
        // binds actor/org/method/path/action/body and consumes the signed nonce.
        match self.verify_actor_envelope(request, org_id, PROJECT_READ_ACTION, None, body) {
            Ok(_) => (),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return project_read_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return project_read_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        }
        let input = match serde_json::from_slice::<ProjectReadRequest>(body) {
            Ok(input)
                if trusted_absolute_path(&input.organization_workspace_root)
                    && !(input.resources_only && input.project_id.is_none()) =>
            {
                input
            }
            _ => {
                return project_read_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "project_read_invalid",
                );
            }
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return project_read_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_projects(
            pool,
            org_id,
            input.project_id.as_deref(),
            input.resources_only,
            &input.organization_workspace_root,
        )
        .await
        {
            // The legacy public list is complete and may exceed generic receipt
            // caps. Do not truncate it as part of this compatibility cutover.
            Ok(response) => HttpResponse::Ok().json(response),
            Err(StoreError::NotFound) => {
                HttpResponse::NotFound().json(serde_json::json!({"error":"Project not found"}))
            }
            Err(StoreError::InvalidInput) => {
                project_read_error(StatusCode::UNPROCESSABLE_ENTITY, "project_read_invalid")
            }
            Err(_) => project_read_error(StatusCode::INTERNAL_SERVER_ERROR, "project_read_failed"),
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
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/project-reads";
    const KEY: &[u8] = b"synthetic-project-read-test-key";

    fn body() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"projectId":null,"resourcesOnly":false,
            "organizationWorkspaceRoot":std::env::temp_dir().join("project-read-unused-root")}))
        .unwrap()
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
            PROJECT_READ_ACTION,
            body,
            "request",
            format!("nonce-{field}"),
            now,
            now + 60,
        )
        .unwrap();
        match field {
            "org" => envelope.organization_id = "10000000-0000-4000-8000-000000000002".to_owned(),
            "action" => envelope.action = "project.create".to_owned(),
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
                "Rust Project reads are unavailable",
            ),
            (StatusCode::UNAUTHORIZED, "Unauthorized"),
        ] {
            let response = project_read_error(status, "project_read_failed");
            assert_eq!(response.status(), status);
            let bytes = actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap();
            let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(payload["error"], message);
            assert_eq!(payload["code"], "project_read_failed");
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
            "root",
            "project",
            "resources",
        ] {
            let state = state();
            let mut body = body();
            let request = signed_request(&body, field);
            if matches!(field, "root" | "project" | "resources") {
                let mut input: serde_json::Value = serde_json::from_slice(&body).unwrap();
                match field {
                    "root" => input["organizationWorkspaceRoot"] = serde_json::json!("/tampered"),
                    "project" => {
                        input["projectId"] =
                            serde_json::json!("20000000-0000-4000-8000-000000000001")
                    }
                    _ => input["resourcesOnly"] = serde_json::json!(true),
                }
                body = serde_json::to_vec(&input).unwrap();
            }
            assert_eq!(
                state.project_read(&request, ORG, &body).await.status(),
                StatusCode::UNAUTHORIZED,
                "{field}"
            );
        }
        let state = state();
        let body = body();
        let request = signed_request(&body, "valid");
        // Valid reads reach the DB boundary even with all mutation pilots off.
        assert_eq!(
            state.project_read(&request, ORG, &body).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.project_read(&request, ORG, &body).await.status(),
            StatusCode::UNAUTHORIZED,
            "nonce replay"
        );
    }

    #[actix_web::test]
    async fn malformed_signed_read_is_rejected_before_database_or_filesystem_access() {
        for body in [br#"{}"#.as_slice(),
            br#"{"projectId":null,"resourcesOnly":true,"organizationWorkspaceRoot":"/unused"}"#,
            br#"{"projectId":null,"resourcesOnly":false,"organizationWorkspaceRoot":"relative"}"#,
            br#"{"projectId":null,"resourcesOnly":false,"organizationWorkspaceRoot":"/unused","owner":"rust"}"#] {
            assert_eq!(state().project_read(&signed_request(body, "malformed"), ORG, body).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        let body = body();
        assert_eq!(
            state()
                .project_read(&TestRequest::post().uri(PATH).to_http_request(), ORG, &body)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
