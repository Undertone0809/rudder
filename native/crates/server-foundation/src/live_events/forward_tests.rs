use super::*;
use crate::{
    ACTOR_ENVELOPE_AUDIENCE, ACTOR_ENVELOPE_HEADER, ACTOR_ENVELOPE_REQUEST_ID_HEADER, ServerConfig,
    ServerRuntime, live_events::FORWARD_PATH,
};
use actix_web::http::StatusCode;
use rudder_auth_core::{ActorEnvelope, ActorIdentity, SigningKey};

fn signed(
    key: &SigningKey,
    actor: ActorIdentity,
    org: &str,
    path: &str,
    action: &str,
    body: &[u8],
    nonce: &str,
) -> ActorEnvelope {
    let now = crate::unix_time_seconds();
    ActorEnvelope::new(
        actor,
        org,
        FORWARD_ACTOR,
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        "POST",
        path,
        action,
        body,
        nonce,
        nonce,
        now - 1,
        now + 30,
    )
    .unwrap()
    .sign_with_key(key)
    .unwrap()
}

#[test]
fn frame_transport_signature_matches_the_node_protocol_golden() {
    let key = SigningKey::new(b"fixture-secret").unwrap();
    let envelope = ActorEnvelope::new(
        ActorIdentity::new("system", FORWARD_ACTOR).unwrap(),
        "fixture-org",
        FORWARD_ACTOR,
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        "POST",
        FORWARD_PATH,
        FORWARD_ACTION,
        br#"{"orgId":"fixture-org"}"#,
        "fixture-request",
        "fixture-nonce",
        999,
        1060,
    )
    .unwrap()
    .sign_with_key(&key)
    .unwrap();
    assert_eq!(
        envelope.signature,
        "d66e58e1091fc31e3aa6b91e9c50f38a2b90edee0645b8f5952473cb2707c649"
    );
}

#[actix_web::test]
async fn signed_frame_forward_endpoint_accepts_only_its_bound_transport_actor_and_nonce() {
    let key = SigningKey::new(b"synthetic-forward-endpoint-key").unwrap();
    let runtime = ServerRuntime::bind(ServerConfig {
        actor_envelope_key: Some(key.clone()),
        workers: 1,
        ..ServerConfig::default()
    })
    .unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let org = "10000000-0000-4000-8000-000000000001";
    let mut subscription = control.state.live_event_publisher.subscribe(org).unwrap();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let body = serde_json::to_vec(&LiveEvent {
        id: 41,
        org_id: org.into(),
        event_type: "activity.logged".into(),
        created_at: "2026-10-28T00:00:00.000Z".into(),
        dedupe_key: Some("synthetic-forward".into()),
        payload: json!({"fixture":true}),
    })
    .unwrap();
    let valid = signed(
        &key,
        ActorIdentity::new("system", FORWARD_ACTOR).unwrap(),
        org,
        FORWARD_PATH,
        FORWARD_ACTION,
        &body,
        "valid-frame",
    );
    for (envelope, expected) in [
        (
            signed(
                &key,
                ActorIdentity::new("system", "wrong-transport").unwrap(),
                org,
                FORWARD_PATH,
                FORWARD_ACTION,
                &body,
                "wrong-actor",
            ),
            StatusCode::UNAUTHORIZED,
        ),
        (
            signed(
                &key,
                ActorIdentity::new("user", FORWARD_ACTOR).unwrap(),
                org,
                FORWARD_PATH,
                FORWARD_ACTION,
                &body,
                "wrong-kind",
            ),
            StatusCode::FORBIDDEN,
        ),
        (
            signed(
                &key,
                ActorIdentity::new("system", FORWARD_ACTOR).unwrap(),
                org,
                FORWARD_PATH,
                "different.action",
                &body,
                "wrong-action",
            ),
            StatusCode::UNAUTHORIZED,
        ),
        (
            signed(
                &key,
                ActorIdentity::new("system", FORWARD_ACTOR).unwrap(),
                org,
                "/internal/different",
                FORWARD_ACTION,
                &body,
                "wrong-path",
            ),
            StatusCode::UNAUTHORIZED,
        ),
        (
            signed(
                &key,
                ActorIdentity::new("system", FORWARD_ACTOR).unwrap(),
                "10000000-0000-4000-8000-000000000002",
                FORWARD_PATH,
                FORWARD_ACTION,
                &body,
                "wrong-org",
            ),
            StatusCode::UNAUTHORIZED,
        ),
        (valid.clone(), StatusCode::OK),
        (valid, StatusCode::UNAUTHORIZED),
    ] {
        let mut response = client
            .post(format!("{base}{FORWARD_PATH}"))
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope).unwrap(),
            ))
            .insert_header((
                ACTOR_ENVELOPE_REQUEST_ID_HEADER,
                envelope.request_id.clone(),
            ))
            .send_body(body.clone())
            .await
            .unwrap();
        let status = response.status();
        let result = response.body().await.unwrap();
        assert_eq!(status, expected, "{}", String::from_utf8_lossy(&result));
    }
    let event = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        subscription.receiver.recv(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(event.id, 1);
    assert_eq!(event.org_id, org);
    assert_eq!(event.payload, json!({"fixture":true}));
    assert!(
        subscription.receiver.try_recv().is_err(),
        "rejected frames never reach subscribers"
    );

    // A correctly signed system actor still has no authority on another route.
    let other_path = "/internal/different";
    let envelope = signed(
        &key,
        ActorIdentity::new("system", FORWARD_ACTOR).unwrap(),
        org,
        other_path,
        FORWARD_ACTION,
        &body,
        "other-route",
    );
    let request = actix_web::test::TestRequest::post()
        .uri(other_path)
        .insert_header((
            ACTOR_ENVELOPE_HEADER,
            serde_json::to_string(&envelope).unwrap(),
        ))
        .insert_header((
            ACTOR_ENVELOPE_REQUEST_ID_HEADER,
            envelope.request_id.clone(),
        ))
        .to_http_request();
    assert!(
        control
            .state
            .verify_actor_envelope(&request, org, FORWARD_ACTION, None, &body)
            .is_err()
    );
    control.shutdown().await;
    task.await.unwrap().unwrap();
}
