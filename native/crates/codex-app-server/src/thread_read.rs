//! Bounded selection from Codex's persisted `thread/read` response.
//!
//! This is a provider-history observation only. It does not start or resume a
//! thread, submit a turn, or decide that a Native Chat turn is complete.

use crate::{
    MAX_FRAME_BYTES, Message, OwnedTransport, ProcessLaunch, RequestId, SessionObservation,
    TransportError, TransportEvent,
};
use serde_json::Value;
use std::{
    fmt,
    path::Path,
    time::{Duration, Instant},
};

const MAX_DURABLE_ID_BYTES: usize = 4096;
const MAX_PUBLIC_ENTRIES: usize = 512;
const MAX_PUBLIC_ENTRY_BYTES: usize = 32 * 1024;
const MAX_PUBLIC_TRANSCRIPT_BYTES: usize = 256 * 1024;

/// Result of looking up one caller-supplied durable turn ID in a thread read.
#[derive(Clone, PartialEq)]
pub enum ThreadReadSelection {
    /// The returned turn is the unique turn whose `id` exactly matched the
    /// caller-supplied durable identity.
    Turn(Value),
    /// The response was valid, but it did not contain the requested turn ID.
    UnknownTurn,
    /// The provider does not implement `thread/read` on this connection.
    Unsupported,
    /// The provider returned a summary, unloaded, or otherwise incomplete turn.
    Incomplete,
}

impl fmt::Debug for ThreadReadSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Turn(_) => formatter.write_str("ThreadReadSelection::Turn(<redacted>)"),
            Self::UnknownTurn => formatter.write_str("ThreadReadSelection::UnknownTurn"),
            Self::Unsupported => formatter.write_str("ThreadReadSelection::Unsupported"),
            Self::Incomplete => formatter.write_str("ThreadReadSelection::Incomplete"),
        }
    }
}

/// Safe, bounded failure states for reading one exact persisted turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ThreadReadError {
    #[error("Codex thread/read frame exceeded its bound")]
    Oversized,
    #[error("Codex thread/read response is malformed or does not match its target")]
    Malformed,
    #[error("Codex rejected the thread/read request")]
    ProviderRejected,
    #[error("Codex does not support thread/read on this connection")]
    Unsupported,
    #[error("Codex thread/read returned an incomplete turn")]
    Incomplete,
    #[error("Codex read-only process is unavailable or timed out")]
    Unavailable,
}

/// Select one turn from a complete, already-correlated JSON-RPC response frame.
///
/// `includeTurns: true` must be sent in the associated `thread/read` request.
/// The caller still owns request registration, transport deadlines, durable
/// checkpointing and any pagination needed for large histories. This function
/// bounds and parses the supplied frame, verifies the exact thread and turn
/// identities, and never substitutes another (including the newest) turn.
pub fn select_thread_read_turn(
    response_frame: &[u8],
    expected_request_id: &RequestId,
    expected_thread_id: &str,
    durable_turn_id: &str,
) -> Result<ThreadReadSelection, ThreadReadError> {
    if response_frame.len() > MAX_FRAME_BYTES
        || !valid_durable_id(expected_thread_id)
        || !valid_durable_id(durable_turn_id)
    {
        return Err(if response_frame.len() > MAX_FRAME_BYTES {
            ThreadReadError::Oversized
        } else {
            ThreadReadError::Malformed
        });
    }

    let message = Message::decode(response_frame).map_err(|_| ThreadReadError::Malformed)?;
    let result = match message {
        Message::Response { id, result } if &id == expected_request_id => result,
        Message::Error { id, error } if &id == expected_request_id => {
            return if error.code == -32601 {
                Ok(ThreadReadSelection::Unsupported)
            } else {
                Err(ThreadReadError::ProviderRejected)
            };
        }
        _ => return Err(ThreadReadError::Malformed),
    };

    select_thread_read_result(&result, expected_thread_id, durable_turn_id)
}

/// Select one durable turn from an already correlated, bounded `thread/read`
/// result. The transport must have sent exactly one read request and verified
/// its response ID before calling this function.
pub fn select_thread_read_result(
    result: &Value,
    expected_thread_id: &str,
    durable_turn_id: &str,
) -> Result<ThreadReadSelection, ThreadReadError> {
    if !valid_durable_id(expected_thread_id) || !valid_durable_id(durable_turn_id) {
        return Err(ThreadReadError::Malformed);
    }
    let thread = result
        .get("thread")
        .and_then(Value::as_object)
        .ok_or(ThreadReadError::Malformed)?;
    if thread.get("id").and_then(Value::as_str) != Some(expected_thread_id) {
        return Err(ThreadReadError::Malformed);
    }
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .ok_or(ThreadReadError::Malformed)?;

    let mut selected = None;
    for turn in turns {
        let object = turn.as_object().ok_or(ThreadReadError::Malformed)?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_durable_id(id))
            .ok_or(ThreadReadError::Malformed)?;
        if !object.get("items").is_some_and(Value::is_array)
            || object.get("status").and_then(Value::as_str).is_none()
        {
            return Err(ThreadReadError::Malformed);
        }
        if id == durable_turn_id {
            if selected.is_some() {
                return Err(ThreadReadError::Malformed);
            }
            selected = Some(turn.clone());
        }
    }

    Ok(match selected {
        Some(turn) if turn.get("itemsView").and_then(Value::as_str) == Some("full") => {
            ThreadReadSelection::Turn(turn)
        }
        Some(_) => ThreadReadSelection::Incomplete,
        None => ThreadReadSelection::UnknownTurn,
    })
}

/// Launch one bounded, read-only Codex connection and return the exact stored
/// turn. The only provider operations are the App Server initialization
/// handshake, one `thread/read(includeTurns: true)`, and a local initialized
/// notification. This API does not expose the generic request surface.
pub fn read_exact_thread_turn(
    launch: ProcessLaunch,
    process_host: &Path,
    expected_codex_home: &str,
    thread_id: &str,
    durable_turn_id: &str,
    timeout: Duration,
) -> Result<ThreadReadSelection, ThreadReadError> {
    if !valid_durable_id(thread_id)
        || !valid_durable_id(durable_turn_id)
        || timeout.is_zero()
        || launch.env.get("CODEX_HOME").map(String::as_str) != Some(expected_codex_home)
        || !matches!(launch.argv.as_slice(), [one] if one == "app-server")
            && !matches!(launch.argv.as_slice(), [one, two] if one == "app-server" && two == "--strict-config")
    {
        return Err(ThreadReadError::Unavailable);
    }
    let mut transport =
        OwnedTransport::launch_external(launch, process_host).map_err(map_transport_error)?;
    read_turn_over_transport(
        &mut transport,
        expected_codex_home,
        thread_id,
        durable_turn_id,
        timeout,
    )
}

fn read_turn_over_transport(
    transport: &mut OwnedTransport,
    expected_codex_home: &str,
    thread_id: &str,
    durable_turn_id: &str,
    timeout: Duration,
) -> Result<ThreadReadSelection, ThreadReadError> {
    if !valid_durable_id(thread_id) || !valid_durable_id(durable_turn_id) || timeout.is_zero() {
        return Err(ThreadReadError::Unavailable);
    }
    let deadline = Instant::now() + timeout;
    wait_for_spawn(transport, deadline)?;
    let initialize_id = transport
        .request(
            "initialize",
            serde_json::json!({
                "clientInfo":{"name":"rudder-transcript-reader","version":env!("CARGO_PKG_VERSION")},
                "capabilities":{"experimentalApi":false}
            }),
        )
        .map_err(map_transport_error)?;
    let initialized = wait_for_response(transport, &initialize_id, "initialize", deadline)?;
    if initialized.get("codexHome").and_then(Value::as_str) != Some(expected_codex_home) {
        return Err(ThreadReadError::Malformed);
    }
    transport
        .notify("initialized", serde_json::json!({}))
        .map_err(map_transport_error)?;
    wait_for_notification_written(transport, deadline)?;
    let read_id = transport
        .request_thread_read(thread_id)
        .map_err(map_transport_error)?;
    let result = match wait_for_response(transport, &read_id, "thread/read", deadline) {
        Ok(result) => result,
        Err(ThreadReadError::Unsupported) => return Ok(ThreadReadSelection::Unsupported),
        Err(error) => return Err(error),
    };
    select_thread_read_result(&result, thread_id, durable_turn_id)
}

/// Project a hydrated Codex turn into the existing public transcript entry
/// union. Unknown item kinds, malformed fields, and oversized content fail as
/// incomplete so callers never report a silently shortened transcript.
pub fn project_public_transcript(
    turn: &Value,
    timestamp: &str,
) -> Result<Vec<Value>, ThreadReadError> {
    if turn.get("itemsView").and_then(Value::as_str) != Some("full")
        || turn.get("items").and_then(Value::as_array).is_none()
        || timestamp.is_empty()
        || timestamp.len() > 128
    {
        return Err(ThreadReadError::Incomplete);
    }
    let items = turn["items"].as_array().expect("checked above");
    if items.len() > MAX_PUBLIC_ENTRIES {
        return Err(ThreadReadError::Incomplete);
    }
    let mut entries = Vec::new();
    for item in items {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .ok_or(ThreadReadError::Malformed)?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| valid_durable_id(value))
            .ok_or(ThreadReadError::Malformed)?;
        match kind {
            "agentMessage" => {
                let phase = item
                    .get("phase")
                    .and_then(Value::as_str)
                    .ok_or(ThreadReadError::Malformed)?;
                match phase {
                    "commentary" | "final_answer" => {
                        let text = bounded_text(item.get("text"))?;
                        entries.push(serde_json::json!({
                            "kind":"assistant", "ts":timestamp, "text":text,
                            "delta":false, "phase":phase
                        }));
                    }
                    // Never surface private reasoning or provider-internal summaries.
                    "analysis" | "justify" | "confidence" | "summary" | "complete"
                    | "notification" | "delegate_summary" => {}
                    _ => return Err(ThreadReadError::Incomplete),
                }
            }
            "commandExecution" => {
                let command = bounded_text(item.get("command"))?;
                let mut input = serde_json::Map::new();
                input.insert("command".to_owned(), Value::String(command.to_owned()));
                if let Some(cwd) = item.get("cwd") {
                    input.insert(
                        "cwd".to_owned(),
                        Value::String(bounded_text(Some(cwd))?.to_owned()),
                    );
                }
                entries.push(serde_json::json!({
                    "kind":"tool_call", "ts":timestamp, "name":"commandExecution",
                    "toolUseId":id, "input":input
                }));
                let exit_code = item.get("exitCode").and_then(Value::as_i64);
                let is_error = exit_code.is_some_and(|code| code != 0)
                    || item.get("status").and_then(Value::as_str) == Some("failed");
                entries.push(serde_json::json!({
                    "kind":"tool_result", "ts":timestamp, "toolUseId":id,
                    "toolName":"commandExecution",
                    "content":exit_code.map_or_else(|| "Process completed".to_owned(), |code| format!("Process exited with code {code}")),
                    "isError":is_error
                }));
            }
            // Deliberately fail closed for provider item shapes that have not
            // received a reviewed public projection.
            _ => return Err(ThreadReadError::Incomplete),
        }
        if entries.len() > MAX_PUBLIC_ENTRIES
            || entries.iter().any(|entry| {
                serde_json::to_vec(entry)
                    .map(|bytes| bytes.len() > MAX_PUBLIC_ENTRY_BYTES)
                    .unwrap_or(true)
            })
        {
            return Err(ThreadReadError::Incomplete);
        }
        let total = serde_json::to_vec(&entries)
            .map_err(|_| ThreadReadError::Malformed)?
            .len();
        if total > MAX_PUBLIC_TRANSCRIPT_BYTES {
            return Err(ThreadReadError::Incomplete);
        }
    }
    if entries.is_empty() {
        return Err(ThreadReadError::Incomplete);
    }
    Ok(entries)
}

fn bounded_text(value: Option<&Value>) -> Result<&str, ThreadReadError> {
    let text = value
        .and_then(Value::as_str)
        .ok_or(ThreadReadError::Malformed)?;
    if text.is_empty() || text.len() > MAX_PUBLIC_ENTRY_BYTES {
        return Err(ThreadReadError::Incomplete);
    }
    Ok(text)
}

fn wait_for_spawn(
    transport: &mut OwnedTransport,
    deadline: Instant,
) -> Result<(), ThreadReadError> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ThreadReadError::Unavailable);
        }
        match transport.receive(remaining).map_err(map_transport_error)? {
            TransportEvent::Lifecycle(event) if event["type"] == "spawned" => return Ok(()),
            TransportEvent::Lifecycle(event)
                if matches!(event["type"].as_str(), Some("terminal" | "app-exit")) =>
            {
                return Err(ThreadReadError::Unavailable);
            }
            TransportEvent::Lifecycle(_) => {}
            _ => return Err(ThreadReadError::Malformed),
        }
    }
}

fn wait_for_notification_written(
    transport: &mut OwnedTransport,
    deadline: Instant,
) -> Result<(), ThreadReadError> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ThreadReadError::Unavailable);
        }
        match transport.receive(remaining).map_err(map_transport_error)? {
            TransportEvent::FrameWritten { request_id: None } => return Ok(()),
            TransportEvent::Lifecycle(event)
                if matches!(event["type"].as_str(), Some("terminal" | "app-exit")) =>
            {
                return Err(ThreadReadError::Unavailable);
            }
            TransportEvent::Lifecycle(_) => {}
            TransportEvent::Rpc(SessionObservation::Incoming(crate::Message::Notification {
                ..
            })) => {}
            _ => return Err(ThreadReadError::Malformed),
        }
    }
}

fn wait_for_response(
    transport: &mut OwnedTransport,
    request_id: &RequestId,
    method: &str,
    deadline: Instant,
) -> Result<Value, ThreadReadError> {
    let mut written = false;
    let mut outcome = None;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ThreadReadError::Unavailable);
        }
        match transport.receive(remaining).map_err(map_transport_error)? {
            TransportEvent::Rpc(SessionObservation::Completed {
                id,
                method: actual,
                outcome: response,
            }) if &id == request_id && actual == method => {
                outcome = Some(response);
            }
            TransportEvent::FrameWritten {
                request_id: Some(id),
            } if &id == request_id => written = true,
            TransportEvent::Rpc(SessionObservation::Incoming(crate::Message::Notification {
                ..
            })) => {}
            TransportEvent::Lifecycle(event) if event["type"] == "terminal" => {
                return Err(ThreadReadError::Unavailable);
            }
            _ => return Err(ThreadReadError::Malformed),
        }
        if written && let Some(outcome) = outcome.take() {
            return outcome.map_err(|error| {
                if method == "thread/read" && error.code == -32601 {
                    ThreadReadError::Unsupported
                } else {
                    ThreadReadError::ProviderRejected
                }
            });
        }
    }
}

fn map_transport_error(error: TransportError) -> ThreadReadError {
    match error {
        TransportError::Timeout => ThreadReadError::Unavailable,
        TransportError::Protocol(crate::ProtocolError::FrameTooLarge)
        | TransportError::Protocol(crate::ProtocolError::ChunkTooLarge) => {
            ThreadReadError::Oversized
        }
        TransportError::Protocol(
            crate::ProtocolError::TruncatedFrame
            | crate::ProtocolError::InvalidFrame
            | crate::ProtocolError::InvalidMessage,
        )
        | TransportError::Session(crate::SessionError::Protocol(
            crate::ProtocolError::TruncatedFrame
            | crate::ProtocolError::InvalidFrame
            | crate::ProtocolError::InvalidMessage,
        )) => ThreadReadError::Malformed,
        TransportError::Session(crate::SessionError::UnmatchedResponse) => {
            ThreadReadError::Malformed
        }
        _ => ThreadReadError::Unavailable,
    }
}

pub(crate) fn valid_durable_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_DURABLE_ID_BYTES
}

#[cfg(all(test, unix))]
mod tests {
    use super::{ThreadReadSelection, project_public_transcript, read_turn_over_transport};
    use crate::{OwnedTransport, ProcessLaunch};
    use serde_json::json;
    use std::{collections::BTreeMap, time::Duration};

    #[test]
    fn exact_reader_uses_one_thread_read_and_projects_allowlisted_entries() {
        let root = tempfile::tempdir().expect("temporary process root");
        let path = root
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let methods_path = root.path().join("methods");
        let lines_path = root.path().join("lines");
        let mut env = BTreeMap::new();
        env.insert("CODEX_HOME".to_owned(), path.clone());
        env.insert(
            "READ_METHODS".to_owned(),
            methods_path.to_string_lossy().into_owned(),
        );
        env.insert(
            "READ_LINES".to_owned(),
            lines_path.to_string_lossy().into_owned(),
        );
        let script = r#"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$READ_LINES"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' initialize >> "$READ_METHODS"
      printf '{"id":0,"result":{"codexHome":"%s"}}\n' "$CODEX_HOME"
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' thread/read >> "$READ_METHODS"
      case "$line" in *'"includeTurns":true'*'"threadId":"thread-exact"'*) ;; *) exit 91 ;; esac
      case "$line" in *thread/start*|*turn/start*|*prompt*) exit 92 ;; esac
      printf '%s\n' '{"id":1,"result":{"thread":{"id":"thread-exact","turns":[{"id":"turn-old","status":"completed","itemsView":"full","items":[{"id":"old-item","type":"agentMessage","phase":"final_answer","text":"old"}]},{"id":"turn-exact","status":"completed","itemsView":"full","items":[{"id":"answer","type":"agentMessage","phase":"final_answer","text":"chosen"},{"id":"private","type":"agentMessage","phase":"analysis","text":"do not expose"},{"id":"command","type":"commandExecution","command":"pwd","cwd":"/workspace","exitCode":0}]},{"id":"turn-newest","status":"completed","itemsView":"full","items":[{"id":"new-item","type":"agentMessage","phase":"final_answer","text":"newest"}] }]}}}'
      ;;
    *'"method":"initialized"'*) ;;
    *) exit 93 ;;
  esac
done
"#;
        let mut transport = OwnedTransport::launch(ProcessLaunch {
            executable: "/bin/sh".into(),
            argv: vec!["-c".into(), script.into()],
            cwd: path.clone(),
            env,
            request_id: "reader-attempt".into(),
            run_id: "reader-run".into(),
            attempt_id: "reader-attempt".into(),
            owner_token: "reader-owner".into(),
            runtime_root: path.clone(),
        })
        .expect("launch synthetic owned process");

        let result = read_turn_over_transport(
            &mut transport,
            &path,
            "thread-exact",
            "turn-exact",
            Duration::from_secs(5),
        );
        assert!(
            result.is_ok(),
            "read failed: {result:?}; methods: {}; lines: {}",
            std::fs::read_to_string(&methods_path).unwrap_or_default(),
            std::fs::read_to_string(&lines_path).unwrap_or_default()
        );
        let ThreadReadSelection::Turn(turn) = result.unwrap() else {
            panic!("the requested historical turn should be selected");
        };
        assert_eq!(turn["id"], "turn-exact");
        let entries = project_public_transcript(&turn, "2026-10-22T00:00:00Z")
            .expect("bounded public projection");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["text"], "chosen");
        assert_eq!(entries[1]["name"], "commandExecution");
        assert_eq!(entries[2]["isError"], false);
        assert!(
            !serde_json::to_string(&entries)
                .unwrap()
                .contains("do not expose")
        );
        drop(transport);
        assert_eq!(
            std::fs::read_to_string(methods_path).unwrap(),
            "initialize\nthread/read\n"
        );
    }

    #[test]
    fn unhydrated_turn_is_not_reported_as_empty_complete_history() {
        let result = json!({"thread":{"id":"thread-exact","turns":[{
            "id":"turn-exact","status":"completed","itemsView":"summary","items":[]
        }]}});
        assert_eq!(
            super::select_thread_read_result(&result, "thread-exact", "turn-exact").unwrap(),
            ThreadReadSelection::Incomplete
        );
    }

    #[test]
    fn unknown_public_item_shape_fails_closed_instead_of_truncating() {
        let turn = json!({
            "id":"turn-exact","status":"completed","itemsView":"full",
            "items":[{"id":"safe","type":"agentMessage","phase":"final_answer","text":"answer"},
                     {"id":"unknown","type":"futureProviderItem","payload":"private"}]
        });
        assert!(project_public_transcript(&turn, "2026-10-22T00:00:00Z").is_err());
    }
}
