use super::*;
use crate::{
    ACTOR_ENVELOPE_AUDIENCE, ACTOR_ENVELOPE_HEADER, ACTOR_ENVELOPE_REQUEST_ID_HEADER,
    ActorEnvelope, ActorIdentity, ServerConfig, SigningKey, unix_time_seconds,
};

const ORG: &str = "10000000-0000-4000-8000-000000000001";
const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/runtime-bindings";
const BODY: &[u8] = br#"{"operation":"current","target":{"targetType":"chat_conversation","targetId":"20000000-0000-4000-8000-000000000001"}}"#;
const KEY: &[u8] = b"synthetic-runtime-binding-signing-key";

fn state() -> web::Data<AppState> {
    web::Data::new(
        AppState::new(ServerConfig {
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap(),
    )
}

fn request(body: &[u8], org: &str, action: &str) -> HttpRequest {
    let now = unix_time_seconds();
    let envelope = ActorEnvelope::new(
        ActorIdentity::new("user", "local-board").unwrap(),
        org,
        "local-implicit",
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        "POST",
        PATH,
        action,
        body,
        "synthetic-binding-request",
        "synthetic-binding-nonce",
        now,
        now + 60,
    )
    .unwrap()
    .sign_with_key(&SigningKey::new(KEY).unwrap())
    .unwrap();
    actix_web::test::TestRequest::post()
        .uri(PATH)
        .insert_header((
            ACTOR_ENVELOPE_HEADER,
            serde_json::to_string(&envelope).unwrap(),
        ))
        .insert_header((
            ACTOR_ENVELOPE_REQUEST_ID_HEADER,
            "synthetic-binding-request",
        ))
        .to_http_request()
}

#[actix_web::test]
async fn binds_organization_operation_and_body_before_database_access() {
    for (org, action, body) in [
        (
            "10000000-0000-4000-8000-000000000002",
            "runtime.binding.current",
            BODY,
        ),
        (ORG, "runtime.binding.ensure", BODY),
        (
            ORG,
            "runtime.binding.current",
            br#"{"operation":"current"}"#.as_slice(),
        ),
    ] {
        let response = command(
            state(),
            request(body, org, action),
            web::Bytes::from_static(BODY),
            web::Path::from(ORG.to_owned()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}

#[actix_web::test]
async fn missing_database_fails_closed_and_same_envelope_cannot_replay() {
    let state = state();
    let response = command(
        state.clone(),
        request(BODY, ORG, "runtime.binding.current"),
        web::Bytes::from_static(BODY),
        web::Path::from(ORG.to_owned()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let replay = command(
        state,
        request(BODY, ORG, "runtime.binding.current"),
        web::Bytes::from_static(BODY),
        web::Path::from(ORG.to_owned()),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
}

#[actix_web::test]
async fn rejects_unsigned_commands_and_unknown_fields() {
    let unsigned = command(
        state(),
        actix_web::test::TestRequest::post()
            .uri(PATH)
            .to_http_request(),
        web::Bytes::from_static(BODY),
        web::Path::from(ORG.to_owned()),
    )
    .await;
    assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);
    let injected = br#"{"operation":"current","target":{"targetType":"chat_conversation","targetId":"20000000-0000-4000-8000-000000000001"},"principalScopeRef":"org:forged"}"#;
    let response = command(
        state(),
        request(injected, ORG, "runtime.binding.current"),
        web::Bytes::from_static(injected),
        web::Path::from(ORG.to_owned()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}
