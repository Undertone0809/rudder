use rudder_codex_app_server::{
    FrameDecoder, MAX_PENDING_REQUESTS, Message, RequestId, RpcError, RpcSession, SessionError,
    SessionObservation,
};
use serde_json::json;

fn prepared_id(session: &mut RpcSession, method: &str) -> RequestId {
    let prepared = session.prepare(method, json!({})).unwrap();
    let Message::Request { id, .. } = FrameDecoder::default()
        .push(prepared.as_bytes())
        .unwrap()
        .remove(0)
    else {
        panic!("expected request")
    };
    assert_eq!(&id, prepared.id());
    id
}

#[test]
fn out_of_order_success_and_error_match_their_exact_request() {
    let mut session = RpcSession::default();
    let first = prepared_id(&mut session, "thread/read");
    let second = prepared_id(&mut session, "turn/start");
    assert_eq!(
        session
            .observe(Message::Response {
                id: second.clone(),
                result: json!({"turn":{"id":"exact"}})
            })
            .unwrap(),
        SessionObservation::Completed {
            id: second,
            method: "turn/start".into(),
            outcome: Ok(json!({"turn":{"id":"exact"}}))
        }
    );
    let error = RpcError {
        code: -32601,
        message: "private provider error".into(),
        data: None,
    };
    let observation = session
        .observe(Message::Error {
            id: first.clone(),
            error: error.clone(),
        })
        .unwrap();
    assert_eq!(
        observation,
        SessionObservation::Completed {
            id: first,
            method: "thread/read".into(),
            outcome: Err(error)
        }
    );
    assert!(!format!("{observation:?}").contains("private"));
    assert_eq!(session.pending_ids().count(), 0);
    assert_eq!(
        prepared_id(&mut session, "thread/read"),
        RequestId::Number(2)
    );
}

#[test]
fn server_requests_and_notifications_do_not_consume_pending_client_ids() {
    let mut session = RpcSession::default();
    let id = prepared_id(&mut session, "turn/start");
    for message in [
        Message::Request {
            id: id.clone(),
            method: "item/commandExecution/requestApproval".into(),
            params: Some(json!({})),
        },
        Message::Notification {
            method: "turn/completed".into(),
            params: Some(json!({"turn":{"id":"unknown"}})),
        },
    ] {
        assert_eq!(
            session.observe(message.clone()).unwrap(),
            SessionObservation::Incoming(message)
        );
    }
    assert_eq!(session.pending_ids().collect::<Vec<_>>(), vec![id]);
}

#[test]
fn differently_typed_unknown_and_duplicate_responses_close_the_session() {
    for response_id in [RequestId::Text("0".into()), RequestId::Number(99)] {
        let mut session = RpcSession::default();
        let pending = prepared_id(&mut session, "turn/start");
        assert_eq!(
            session.observe(Message::Response {
                id: response_id,
                result: json!(null)
            }),
            Err(SessionError::UnmatchedResponse)
        );
        assert!(session.is_closed());
        assert_eq!(session.pending_ids().collect::<Vec<_>>(), vec![pending]);
        assert_eq!(
            session.prepare("turn/start", json!({})),
            Err(SessionError::Closed)
        );
    }
    let mut session = RpcSession::default();
    let id = prepared_id(&mut session, "initialize");
    let response = Message::Response {
        id,
        result: json!({}),
    };
    session.observe(response.clone()).unwrap();
    assert_eq!(
        session.observe(response),
        Err(SessionError::UnmatchedResponse)
    );
}

#[test]
fn capacity_bounds_requests_without_dropping_or_reusing_identifiers() {
    let mut session = RpcSession::default();
    for _ in 0..MAX_PENDING_REQUESTS {
        prepared_id(&mut session, "thread/read");
    }
    assert_eq!(
        session.prepare("turn/start", json!({})),
        Err(SessionError::PendingLimit)
    );
    session
        .observe(Message::Response {
            id: RequestId::Number(0),
            result: json!({}),
        })
        .unwrap();
    assert_eq!(
        prepared_id(&mut session, "turn/start"),
        RequestId::Number(MAX_PENDING_REQUESTS as i64)
    );
    assert_eq!(session.pending_ids().count(), MAX_PENDING_REQUESTS);
}

#[test]
fn transport_loss_preserves_pending_uncertainty_and_cannot_be_reopened() {
    let mut session = RpcSession::default();
    let pending = prepared_id(&mut session, "turn/start");
    session.close();
    assert_eq!(
        session.pending_ids().collect::<Vec<_>>(),
        vec![pending.clone()]
    );
    assert_eq!(
        session.observe(Message::Response {
            id: pending,
            result: json!({})
        }),
        Err(SessionError::Closed)
    );
    assert_eq!(
        session.prepare("turn/start", json!({})),
        Err(SessionError::Closed)
    );
}

#[test]
fn encode_failure_does_not_register_or_consume_a_request_id() {
    let mut session = RpcSession::default();
    assert!(matches!(
        session.prepare("bad method", json!({})),
        Err(SessionError::Protocol(_))
    ));
    assert_eq!(session.pending_ids().count(), 0);
    assert_eq!(
        prepared_id(&mut session, "initialize"),
        RequestId::Number(0)
    );
}
