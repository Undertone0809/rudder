mod support;

use actix_web::{App, HttpMessage, dev::Service, http::StatusCode, test, web};
use rudder_agent_permissions_service::{AuthenticatedActor, PermissionService, configure};
use serde_json::{Value, json};
use support::*;

#[actix_web::test]
async fn typed_routes_reject_missing_context_and_preserve_error_bodies() {
    let db = Database::start().await;
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(PermissionService::new(db.pool.clone())))
            .configure(configure),
    )
    .await;
    let request = test::TestRequest::patch()
        .uri(&format!("/api/agents/{TARGET}/permissions"))
        .set_json(json!({"canCreateAgents":false,"canAssignTasks":false}))
        .to_request();
    let response = app.call(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        json!({"error":"Unauthorized"})
    );

    let request = test::TestRequest::patch()
        .uri(&format!("/api/agents/{TARGET}/permissions"))
        .set_json(json!({
            "canCreateAgents": false,
            "canAssignTasks": false
        }))
        .to_request();
    request
        .extensions_mut()
        .insert(AuthenticatedActor::agent(ORG, TARGET, None));
    let response = app.call(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        test::read_body_json::<Value, _>(response).await,
        json!({"error":"Only CEO can manage permissions"})
    );
}

#[actix_web::test]
async fn patch_exercises_the_real_atomic_service() {
    let db = Database::start().await;
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(PermissionService::new(db.pool.clone())))
            .configure(configure),
    )
    .await;
    let request = test::TestRequest::patch()
        .uri(&format!("/api/agents/{TARGET}/permissions"))
        .set_json(json!({
            "canCreateAgents": false,
            "canManageSkills": false,
            "canAssignTasks": true,
            "futureFieldIgnoredLikeZod": "value"
        }))
        .to_request();
    request
        .extensions_mut()
        .insert(AuthenticatedActor::local_implicit_board());
    let response = app.call(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = test::read_body_json(response).await;
    assert_eq!(body["permissions"]["canCreateAgents"], false);
    assert_eq!(body["permissions"]["canManageSkills"], false);
    assert_eq!(body["canAssignTasks"], true);
    assert_eq!(body["taskAssignSource"], "explicit_grant");
}
