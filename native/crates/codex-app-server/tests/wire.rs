use rudder_codex_app_server::{
    FrameDecoder, MAX_CHUNK_BYTES, MAX_FRAME_BYTES, Message, ProtocolError, RequestId,
    encode_notification, encode_request,
};
use serde_json::json;

#[test]
fn documented_notification_timestamp_and_request_trace_are_metadata_only() {
    let messages = FrameDecoder::default().push(b"{\"method\":\"thread/started\",\"params\":{},\"emittedAtMs\":1792200000000}\n{\"id\":5,\"method\":\"item/commandExecution/requestApproval\",\"params\":{},\"trace\":{\"traceparent\":\"opaque\",\"tracestate\":null}}\n").unwrap();
    assert!(
        matches!(&messages[0], Message::Notification { method, params: Some(params) } if method == "thread/started" && params == &json!({}))
    );
    assert!(matches!(
        &messages[1],
        Message::Request {
            id: RequestId::Number(5),
            ..
        }
    ));
    for frame in [
        r#"{"method":"thread/started","emittedAtMs":"not-a-time"}"#,
        r#"{"method":"thread/started","emittedAtMs":1.25}"#,
        r#"{"id":1,"method":"approval","trace":{"traceparent":1}}"#,
        r#"{"id":1,"method":"approval","trace":{"unknown":"value"}}"#,
        r#"{"method":"thread/started","emittedAtMs":1,"result":null}"#,
    ] {
        assert_eq!(
            FrameDecoder::default().push(format!("{frame}\n").as_bytes()),
            Err(ProtocolError::InvalidMessage)
        );
    }
}

#[test]
fn codex_markerless_wire_keeps_numeric_and_text_request_ids_distinct() {
    let messages = FrameDecoder::default().push(
        b"{\"id\":7,\"result\":null}\n{\"id\":\"7\",\"result\":{\"thread\":{\"id\":\"  Exact/Thread  \"}}}\n"
    ).unwrap();
    assert_eq!(
        messages[0],
        Message::Response {
            id: RequestId::Number(7),
            result: json!(null)
        }
    );
    assert_eq!(
        messages[1],
        Message::Response {
            id: RequestId::Text("7".into()),
            result: json!({"thread":{"id":"  Exact/Thread  "}}),
        }
    );
}

#[test]
fn utf8_and_crlf_are_correct_at_every_byte_boundary() {
    let bytes =
        "{\"method\":\"item/agentMessage/delta\",\"params\":{\"delta\":\"你好🦀\"}}\r\n".as_bytes();
    let expected = vec![Message::Notification {
        method: "item/agentMessage/delta".into(),
        params: Some(json!({"delta":"你好🦀"})),
    }];
    for offset in 0..=bytes.len() {
        let mut decoder = FrameDecoder::default();
        let mut messages = decoder.push(&bytes[..offset]).unwrap();
        messages.extend(decoder.push(&bytes[offset..]).unwrap());
        assert_eq!(messages, expected, "split at {offset}");
        decoder.finish().unwrap();
    }
}

#[test]
fn server_approval_requests_remain_requests_never_success_observations() {
    let message = FrameDecoder::default().push(
        b"{\"id\":\"approval-1\",\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"command\":\"opaque\"}}\n"
    ).unwrap().remove(0);
    assert!(matches!(
        message,
        Message::Request {
            id: RequestId::Text(_),
            ..
        }
    ));
}

#[test]
fn ambiguous_shapes_duplicate_ids_and_invalid_versions_poison_stream() {
    for frame in [
        "{\"id\":1,\"id\":2,\"result\":null}",
        "{\"id\":null,\"result\":null}",
        "{\"id\":1.2,\"result\":null}",
        "{\"id\":1,\"result\":null,\"error\":{\"code\":1,\"message\":\"x\"}}",
        "{\"id\":1,\"method\":\"thread/start\",\"result\":null}",
        "{\"id\":1,\"jsonrpc\":\"1.0\",\"result\":null}",
        "{\"method\":\"\",\"params\":{}}",
        "{\"id\":1}",
        "[{}]",
    ] {
        let mut decoder = FrameDecoder::default();
        assert!(
            decoder.push(format!("{frame}\n").as_bytes()).is_err(),
            "{frame}"
        );
        assert_eq!(
            decoder.push(b"{\"id\":1,\"result\":null}\n"),
            Err(ProtocolError::StreamFailed)
        );
    }
}

#[test]
fn invalid_utf8_and_truncated_frames_are_not_silently_repaired() {
    let mut decoder = FrameDecoder::default();
    assert_eq!(
        decoder.push(b"{\"method\":\"x\",\"params\":\"\xff\"}\n"),
        Err(ProtocolError::InvalidFrame)
    );
    let mut decoder = FrameDecoder::default();
    assert!(
        decoder
            .push(b"{\"id\":1,\"result\":null}")
            .unwrap()
            .is_empty()
    );
    assert_eq!(decoder.finish(), Err(ProtocolError::TruncatedFrame));
    assert_eq!(decoder.push(b"\n"), Err(ProtocolError::StreamFailed));
}

#[test]
fn frame_and_chunk_limits_fail_closed_without_accepting_a_prefix() {
    let mut decoder = FrameDecoder::default();
    assert_eq!(
        decoder.push(&vec![b' '; MAX_CHUNK_BYTES + 1]),
        Err(ProtocolError::ChunkTooLarge)
    );
    let mut decoder = FrameDecoder::default();
    for _ in 0..MAX_FRAME_BYTES / MAX_CHUNK_BYTES {
        assert!(
            decoder
                .push(&vec![b' '; MAX_CHUNK_BYTES])
                .unwrap()
                .is_empty()
        );
    }
    assert_eq!(decoder.push(b"x"), Err(ProtocolError::FrameTooLarge));
    assert_eq!(decoder.push(b"\n"), Err(ProtocolError::StreamFailed));
}

#[test]
fn encoded_input_stays_one_frame_and_does_not_add_history() {
    let input = "new user input\nwith a newline";
    let bytes = encode_request(
        &RequestId::Text("turn-1".into()),
        "turn/start",
        json!({
            "threadId":" Thread ", "clientUserMessageId":"message-1",
            "input":[{"type":"text","text":input,"text_elements":[]}],
        }),
    )
    .unwrap();
    assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
    let message = FrameDecoder::default().push(&bytes).unwrap().remove(0);
    let Message::Request {
        id,
        method,
        params: Some(params),
    } = message
    else {
        panic!("request expected")
    };
    assert_eq!(id, RequestId::Text("turn-1".into()));
    assert_eq!(method, "turn/start");
    assert_eq!(params["input"].as_array().unwrap().len(), 1);
    assert_eq!(params["input"][0]["text"], input);
    assert_eq!(params["threadId"], " Thread ");
    let notification = encode_notification("initialized", json!({})).unwrap();
    assert!(matches!(
        FrameDecoder::default().push(&notification).unwrap()[0],
        Message::Notification { .. }
    ));
}

#[test]
fn provider_error_is_distinct_from_success_and_diagnostics_do_not_echo_payload() {
    let messages = FrameDecoder::default().push(
        b"{\"jsonrpc\":\"2.0\",\"id\":-7,\"error\":{\"code\":-32601,\"message\":\"unsupported\",\"data\":null}}\n"
    ).unwrap();
    assert!(
        matches!(&messages[0], Message::Error { id: RequestId::Number(-7), error } if error.code == -32601)
    );
    let error = FrameDecoder::default()
        .push(b"private-provider-data\n")
        .unwrap_err();
    assert!(!error.to_string().contains("private-provider-data"));
    assert!(!format!("{messages:?}").contains("unsupported"));
    let Message::Error { error, .. } = &messages[0] else {
        panic!("error expected")
    };
    assert!(!format!("{error:?}").contains("unsupported"));
}

#[test]
fn clean_eof_cannot_be_reopened_by_late_bytes() {
    let mut decoder = FrameDecoder::default();
    decoder.finish().unwrap();
    assert_eq!(
        decoder.push(b"{\"id\":1,\"result\":null}\n"),
        Err(ProtocolError::StreamFailed)
    );
}

#[test]
fn nested_identity_duplicates_and_escaped_key_aliases_are_rejected() {
    for frame in [
        r#"{"id":1,"result":{"thread":{"id":"first","id":"second"}}}"#,
        r#"{"method":"turn/started","params":{"threadId":"first","threadId":"second","turn":{"id":"turn"}}}"#,
        r#"{"id":1,"result":{"turns":[{"id":"first","\u0069d":"second"}]}}"#,
        r#"{"id":1,"error":{"code":-1,"message":"error","data":{"a":1,"a":2}}}"#,
    ] {
        let mut decoder = FrameDecoder::default();
        assert_eq!(
            decoder.push(format!("{frame}\n").as_bytes()),
            Err(ProtocolError::InvalidFrame)
        );
        assert_eq!(decoder.push(b"\n"), Err(ProtocolError::StreamFailed));
    }
}

#[test]
fn recursive_parser_preserves_valid_json_and_bounds_nesting() {
    let frame = b"{\"id\":1,\"result\":{\"values\":[null,true,false,-12,18446744073709551615,1.25,\"text\",{}]}}\n";
    let messages = FrameDecoder::default().push(frame).unwrap();
    let Message::Response { result, .. } = &messages[0] else {
        panic!("response expected")
    };
    assert_eq!(result["values"][0], json!(null));
    assert_eq!(result["values"][4].as_u64(), Some(u64::MAX));
    assert_eq!(result["values"][5], json!(1.25));
    let deep = format!(
        "{{\"id\":1,\"result\":{}0{}}}\n",
        "[".repeat(200),
        "]".repeat(200)
    );
    assert_eq!(
        FrameDecoder::default().push(deep.as_bytes()),
        Err(ProtocolError::InvalidFrame)
    );
}
