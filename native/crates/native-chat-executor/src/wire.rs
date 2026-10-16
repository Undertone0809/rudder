use crate::{Error, Result};
use rudder_codex_app_server::TurnStatus;
use rudder_d1_persistence::native_chat::config::ResolvedCodexConfig;
use serde_json::{Value, json};

/// Exact opaque locators are never trimmed, interpreted as paths, or selected
/// by recency. This bound agrees with the durable checkpoint contract.
pub(crate) fn locator(value: &Value) -> Result<String> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 4096)
        .map(str::to_owned)
        .ok_or(Error::InvalidProviderObservation)
}

pub(crate) fn thread_params(config: &ResolvedCodexConfig) -> Value {
    json!({
        "model": config.model,
        "ephemeral": false,
        "cwd": config.cwd.to_string_lossy(),
        "approvalPolicy": "on-request",
        "sandbox": "read-only",
        "developerInstructions": config.instruction_content,
        "config": {"web_search": "disabled"},
    })
}

pub(crate) fn turn_params(
    thread: &str,
    source_message: &str,
    body: &str,
    config: &ResolvedCodexConfig,
) -> Value {
    json!({
        "threadId": thread,
        "clientUserMessageId": source_message,
        "cwd": config.cwd.to_string_lossy(),
        "input": [{"type": "text", "text": body, "text_elements": []}],
        "model": config.model,
        "effort": config.reasoning_effort,
        "approvalPolicy": "on-request",
        "sandboxPolicy": {"type": "readOnly", "networkAccess": false},
    })
}

pub(crate) type ProviderStatus = TurnStatus;

/// Provider data remains private and is not durable Run-completion evidence.
/// Projection and billing must be validated by a separate finalizer.
pub struct ProviderTerminal {
    pub thread_id: String,
    pub turn_id: String,
    pub status: ProviderStatus,
}

pub(crate) fn terminal(params: Value, thread: &str, turn: &str) -> Result<ProviderTerminal> {
    if locator(&params["threadId"])? != thread || locator(&params["turn"]["id"])? != turn {
        return Err(Error::InvalidProviderObservation);
    }
    let status = match params["turn"]["status"].as_str() {
        Some("completed") => ProviderStatus::Completed,
        Some("failed") => ProviderStatus::Failed,
        Some("interrupted") => ProviderStatus::Interrupted,
        _ => return Err(Error::InvalidProviderObservation),
    };
    Ok(ProviderTerminal {
        thread_id: thread.into(),
        turn_id: turn.into(),
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_requires_exact_thread_turn_and_terminal_status() {
        let valid = json!({"threadId":" opaque thread ","turn":{"id":"turn/1","status":"completed","items":[]}});
        assert!(terminal(valid.clone(), " opaque thread ", "turn/1").is_ok());
        assert!(terminal(valid.clone(), "opaque thread", "turn/1").is_err());
        assert!(terminal(valid.clone(), " opaque thread ", "turn/2").is_err());
        let mut active = valid;
        active["turn"]["status"] = json!("inProgress");
        assert!(terminal(active, " opaque thread ", "turn/1").is_err());
    }

    #[test]
    fn malformed_terminal_payload_is_not_completion() {
        assert!(terminal(Value::Null, "t", "u").is_err());
        let summary =
            json!({"threadId":"t","turn":{"id":"u","status":"completed","itemsView":"notLoaded"}});
        assert!(terminal(summary, "t", "u").is_ok());
        assert!(locator(&json!("x".repeat(4097))).is_err());
        assert!(locator(&json!(" ")).is_ok());
    }
}
