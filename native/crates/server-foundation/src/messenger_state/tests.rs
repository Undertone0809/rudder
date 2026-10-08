use super::*;
use crate::{
    ACTOR_ENVELOPE_AUDIENCE, ACTOR_ENVELOPE_HEADER, ACTOR_ENVELOPE_REQUEST_ID_HEADER,
    ActorEnvelope, ActorIdentity, ServerConfig, SigningKey, unix_time_seconds,
};
use actix_web::test::TestRequest;

const ORG: &str = "10000000-0000-4000-8000-000000000001";
const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/messenger-state";
const KEY: &[u8] = b"synthetic-messenger-test-key";
fn state() -> AppState {
    AppState::new(ServerConfig {
        actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
        ..ServerConfig::default()
    })
    .unwrap()
}
fn signed(body: &[u8], field: &str) -> HttpRequest {
    let now = unix_time_seconds();
    let mut e = ActorEnvelope::new(
        ActorIdentity::new(if field == "agent" { "agent" } else { "user" }, "user-a").unwrap(),
        ORG,
        "session",
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        "POST",
        PATH,
        MESSENGER_STATE_ACTION,
        body,
        "request",
        format!("nonce-{field}"),
        now,
        now + 60,
    )
    .unwrap();
    match field {
        "org" => e.organization_id = "20000000-0000-4000-8000-000000000001".into(),
        "path" => e.path = format!("{PATH}/other"),
        "method" => e.method = "GET".into(),
        "action" => e.action = "live_run.read".into(),
        "request" => e.request_id = "other".into(),
        _ => (),
    }
    TestRequest::post()
        .uri(PATH)
        .insert_header((
            ACTOR_ENVELOPE_HEADER,
            serde_json::to_string(&e.sign(KEY).unwrap()).unwrap(),
        ))
        .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, "request"))
        .to_http_request()
}
fn body(input: &str) -> String {
    format!(r#"{{"input":{input},"auditContext":{{"userNames":[],"homeDirs":[]}}}}"#)
}
#[actix_web::test]
async fn binds_actor_org_method_path_action_body_request_and_nonce() {
    let body = body(r#"{"operation":"savedViewList","query":{}}"#);
    for field in ["org", "path", "method", "action", "request", "body"] {
        let actual = if field == "body" {
            b"{}".as_slice()
        } else {
            body.as_bytes()
        };
        assert_eq!(
            state()
                .messenger_state(&signed(body.as_bytes(), field), ORG, actual)
                .await
                .status(),
            StatusCode::UNAUTHORIZED,
            "{field}"
        );
    }
    let s = state();
    let req = signed(body.as_bytes(), "valid");
    assert_eq!(
        s.messenger_state(&req, ORG, body.as_bytes()).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        s.messenger_state(&req, ORG, body.as_bytes()).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        state()
            .messenger_state(&signed(body.as_bytes(), "agent"), ORG, body.as_bytes())
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
}
#[actix_web::test]
async fn rejects_unknown_commands_fields_owner_injection_and_invalid_shapes() {
    for input in [
        r#"{"operation":"arbitrarySql","sql":"DELETE FROM issues"}"#,
        r#"{"operation":"savedViewList","query":{},"userId":"another-user"}"#,
        r#"{"operation":"savedViewList","query":{"limit":101}}"#,
        r#"{"operation":"savedViewList","query":{"visibility":"private"}}"#,
        r#"{"operation":"savedViewList","query":{"extra":true}}"#,
        r#"{"operation":"savedViewGet","id":"invalid"}"#,
        r#"{"operation":"groupUpdate","groupId":"10000000-0000-4000-8000-000000000001","patch":{"userId":"another-user"}}"#,
        r#"{"operation":"savedViewReorder","ids":["10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000001"]}"#,
        r#"{"operation":"savedViewUpdate","id":"10000000-0000-4000-8000-000000000001","patch":{}}"#,
    ] {
        let body = body(input);
        assert_eq!(
            state()
                .messenger_state(&signed(body.as_bytes(), "invalid"), ORG, body.as_bytes())
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{input}"
        );
    }
    let body=br#"{"input":{"operation":"savedViewList","query":{}},"auditContext":{"userNames":[],"homeDirs":[]},"userId":"bad"}"#;
    assert_eq!(
        state()
            .messenger_state(&signed(body, "invalid"), ORG, body)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}
#[test]
fn nullable_patch_fields_do_not_collapse_into_omission() {
    let p: protocol::SavedPatch = serde_json::from_str(r#"{"subtitle":null,"title":"x"}"#).unwrap();
    assert!(p.subtitle.present());
    assert!(p.subtitle.value().is_none());
    assert!(!p.favicon.present());
}
