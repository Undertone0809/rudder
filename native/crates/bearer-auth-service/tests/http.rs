#[allow(dead_code)]
mod common;
use actix_web::{App, HttpResponse, http::StatusCode, test, web};
use common::*;
use rudder_bearer_auth_service::{AuthenticatedActor, AuthorizationError, BearerAuth, BoardActor};
use serde_json::{Value, json};

async fn who(actor: AuthenticatedActor) -> HttpResponse {
    HttpResponse::Ok().json(actor.0)
}
async fn board(actor: BoardActor) -> HttpResponse {
    HttpResponse::Ok().json(actor.0)
}
async fn scoped(
    actor: AuthenticatedActor,
    org: web::Path<String>,
) -> Result<HttpResponse, AuthorizationError> {
    actor.0.require_organization(&org)?;
    Ok(HttpResponse::Ok().json(actor.0))
}
macro_rules! application {
    ($auth:expr) => {
        test::init_service(
            App::new()
                .wrap(BearerAuth::new($auth))
                .route("/api/who", web::route().to(who))
                .route("/api/board", web::get().to(board))
                .route("/api/orgs/{org}/probe", web::get().to(scoped)),
        )
        .await
    };
}

#[actix_web::test]
async fn protected_endpoints_reject_anonymous_headers_and_enforce_database_org_scope() {
    let db = Database::start().await;
    let key = agent_key(&db).await;
    let app = application!(auth(&db));
    let request = test::TestRequest::get()
        .uri("/api/who")
        .insert_header(("x-rudder-actor-type", "board"))
        .insert_header(("x-rudder-org-id", ORG))
        .to_request();
    assert_eq!(
        test::call_service(&app, request).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let request = test::TestRequest::get()
        .uri(&format!("/api/orgs/{ORG}/probe"))
        .insert_header(("authorization", format!("Bearer {}", key.token)))
        .to_request();
    assert_eq!(
        test::call_service(&app, request).await.status(),
        StatusCode::OK
    );
    let request = test::TestRequest::get()
        .uri(&format!("/api/orgs/{OTHER}/probe"))
        .insert_header(("authorization", format!("Bearer {}", key.token)))
        .to_request();
    assert_eq!(
        test::call_service(&app, request).await.status(),
        StatusCode::FORBIDDEN
    );
    let request = test::TestRequest::get()
        .uri("/api/board")
        .insert_header(("authorization", format!("Bearer {}", key.token)))
        .to_request();
    assert_eq!(
        test::call_service(&app, request).await.status(),
        StatusCode::FORBIDDEN
    );
}

#[actix_web::test]
async fn signed_run_mismatch_preserves_the_exact_node_response_and_valid_metadata() {
    let db = Database::start().await;
    let token = node_token();
    let app = application!(auth(&db));
    let request = test::TestRequest::post()
        .uri("/api/who")
        .insert_header(("authorization", format!("Bearer {token}")))
        .insert_header(("x-rudder-run-id", "other-run"))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(
        body,
        json!({"error":"Agent run header does not match the signed runtime context","code":"agent_run_context_mismatch","details":{"signedRunId":RUN,"requestedRunId":"other-run"}})
    );
    let request = test::TestRequest::post()
        .uri("/api/who")
        .insert_header(("authorization", format!("bEaReR {token}")))
        .insert_header(("x-rudder-run-id", RUN))
        .insert_header(("x-rudder-agent-id", CEO))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body["source"], "agent_jwt");
    assert_eq!(body["runId"], RUN);
    assert_eq!(body["adapterType"], "codex_local");
}

#[actix_web::test]
async fn mutations_enforce_agent_context_but_reads_keep_the_existing_semantics() {
    let db = Database::start().await;
    let key = agent_key(&db).await;
    let app = application!(auth(&db));
    let request = test::TestRequest::post()
        .uri("/api/who")
        .insert_header(("authorization", format!("Bearer {}", key.token)))
        .insert_header(("x-rudder-agent-id", "other-agent"))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(
        body,
        json!({"error":"Agent authentication does not match the CLI agent context","code":"agent_context_mismatch","details":{"expectedAgentId":"other-agent","authenticatedAgentId":CEO}})
    );
    let request = test::TestRequest::get()
        .uri("/api/who")
        .insert_header(("authorization", format!("Bearer {}", key.token)))
        .insert_header(("x-rudder-agent-id", "other-agent"))
        .to_request();
    assert_eq!(
        test::call_service(&app, request).await.status(),
        StatusCode::OK
    );
    let request = test::TestRequest::post()
        .uri("/api/who")
        .insert_header(("x-rudder-agent-id", CEO))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(
        body,
        json!({"error":"Agent authentication required for agent-scoped CLI request","code":"agent_auth_required","details":{"expectedAgentId":CEO,"actorType":"none","actorSource":"none"}})
    );
}

#[actix_web::test]
async fn board_agent_context_rejection_does_not_masquerade_as_agent_authentication() {
    let db = Database::start().await;
    let token = "synthetic-http-board";
    board_key(&db, token).await;
    let app = application!(auth(&db));
    let request = test::TestRequest::post()
        .uri("/api/who")
        .insert_header(("authorization", format!("Bearer {token}")))
        .insert_header(("x-rudder-agent-id", CEO))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(
        body,
        json!({"error":"Agent authentication required for agent-scoped CLI request","code":"agent_auth_required","details":{"expectedAgentId":CEO,"actorType":"board","actorSource":"board_key"}})
    );
    let request = test::TestRequest::get()
        .uri("/api/board")
        .insert_header(("authorization", format!("Bearer {token}")))
        .to_request();
    assert_eq!(
        test::call_service(&app, request).await.status(),
        StatusCode::OK
    );
}

#[actix_web::test]
async fn duplicated_and_oversized_authentication_headers_are_rejected_without_reflection() {
    let db = Database::start().await;
    let key = agent_key(&db).await;
    let app = application!(auth(&db));
    let request = test::TestRequest::get()
        .uri("/api/who")
        .append_header(("authorization", format!("Bearer {}", key.token)))
        .append_header(("authorization", "Bearer forged"))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body, json!({"error":"Invalid authentication headers"}));
    let request = test::TestRequest::post()
        .uri("/api/who")
        .insert_header(("x-rudder-agent-id", "x".repeat(1025)))
        .to_request();
    assert_eq!(
        test::call_service(&app, request).await.status(),
        StatusCode::BAD_REQUEST
    );
}

#[actix_web::test]
async fn database_failure_is_not_accepted_as_an_anonymous_or_board_request() {
    let db = Database::start().await;
    let authenticator = auth(&db);
    db.pool.close().await;
    let app = application!(authenticator);
    let request = test::TestRequest::get()
        .uri("/api/who")
        .insert_header(("authorization", "Bearer synthetic-unavailable-db"))
        .to_request();
    let response = test::call_service(&app, request).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body, json!({"error":"Authentication lookup failed"}));
}
// End of actual Actix bearer workflow regressions.
