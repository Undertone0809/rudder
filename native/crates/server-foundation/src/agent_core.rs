use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::agent_core::{
    AgentCoreError, AgentCoreRequest, admit_agent, execute_agent,
};
use serde_json::json;
pub(super) async fn agent_core(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
) -> HttpResponse {
    let actor=match state.verify_actor_envelope(&request,"agent-core","agent.core.execute",None,&body){
        Ok(actor)=>actor,
        Err(ActorEnvelopeVerificationError::Unconfigured)=>return HttpResponse::ServiceUnavailable().json(json!({"error":"Rust Agent core is unavailable","code":"actor_envelope_unconfigured"})),
        Err(_)=>return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized","code":"actor_envelope_invalid"})),
    };
    let command = match AgentCoreRequest::parse(&body) {
        Ok(v) => v,
        Err(_) => return HttpResponse::BadRequest().json(json!({"error":"Invalid Agent command"})),
    };
    if let Err(error) = admit_agent(&actor, &command) {
        return response_error(error);
    }
    let DatabaseState::Configured(pool) = &state.database else {
        return HttpResponse::ServiceUnavailable()
            .json(json!({"error":"Rust Agent core is unavailable","code":"database_disabled"}));
    };
    match execute_agent(pool, &actor, &command).await {
        Ok((status, body)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .content_type("application/json; charset=utf-8")
        .body(body),
        Err(error) => response_error(error),
    }
}
fn response_error(error: AgentCoreError) -> HttpResponse {
    match error {
        AgentCoreError::Http(status, message, details) => {
            let mut value = json!({"error":message});
            if let Some(details) = details {
                value["details"] = details;
            }
            HttpResponse::build(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            )
            .json(value)
        }
        AgentCoreError::Database(error) => {
            tracing::warn!(error=?error,"Agent authority database command failed");
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
    use serde_json::Value;
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
            "agent-core",
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
    async fn binds_every_command_field_and_rejects_nonce_replay() {
        let original=br#"{"operation":"keys","id":"50000000-0000-4000-8000-000000000001","query":{},"input":{},"localImplicit":true}"#;
        for field in [
            "operation",
            "orgId",
            "id",
            "input",
            "query",
            "localImplicit",
            "resolveOnly",
            "organizationAgentsRoot",
            "actorRunId",
        ] {
            let mut modified: Value = serde_json::from_slice(original).unwrap();
            modified[field] = json!("tampered");
            let response = agent_core(
                state(),
                request(
                    original,
                    "user",
                    "/internal/agent-core",
                    "agent.core.execute",
                ),
                web::Bytes::from(modified.to_string()),
            )
            .await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{field}");
        }
        let state = state();
        let request = request(
            original,
            "user",
            "/internal/agent-core",
            "agent.core.execute",
        );
        assert_eq!(
            agent_core(
                state.clone(),
                request.clone(),
                web::Bytes::from_static(original)
            )
            .await
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            agent_core(state, request, web::Bytes::from_static(original))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[actix_web::test]
    async fn anonymous_fact_only_preserves_this_routes_validation_priority() {
        for (body, expected) in [
            (
                br#"{"operation":"key-create","id":"50000000-0000-4000-8000-000000000001"}"#
                    .as_slice(),
                400,
            ),
            (
                br#"{"operation":"keys","id":"50000000-0000-4000-8000-000000000001"}"#.as_slice(),
                403,
            ),
            (
                br#"{"operation":"list","orgId":"10000000-0000-4000-8000-000000000001"}"#
                    .as_slice(),
                401,
            ),
        ] {
            assert_eq!(
                agent_core(
                    state(),
                    request(
                        body,
                        "anonymous",
                        "/internal/agent-core",
                        "agent.core.execute"
                    ),
                    web::Bytes::copy_from_slice(body)
                )
                .await
                .status()
                .as_u16(),
                expected
            );
        }
        let body = br#"{"operation":"keys"}"#;
        for (path, action) in [
            ("/internal/agent-core", "calendar.execute"),
            ("/internal/orgs/x/calendar", "agent.core.execute"),
        ] {
            assert_eq!(
                agent_core(
                    state(),
                    request(body, "anonymous", path, action),
                    web::Bytes::from_static(body)
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
}
