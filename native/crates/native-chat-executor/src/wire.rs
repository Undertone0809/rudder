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
    let mut params = json!({
        "ephemeral": false,
        "cwd": config.cwd.to_string_lossy(),
        "config": {
            "web_search": if config.search_enabled { "live" } else { "disabled" }
        },
    });
    if let Some(model) = &config.model {
        params["model"] = json!(model);
    }
    if let Some(instructions) = &config.instruction_content {
        params["developerInstructions"] = json!(instructions);
    }
    params
}

pub(crate) fn turn_params(
    thread: &str,
    source_message: &str,
    body: &str,
    config: &ResolvedCodexConfig,
) -> Value {
    let mut params = json!({
        "threadId": thread,
        "clientUserMessageId": source_message,
        "cwd": config.cwd.to_string_lossy(),
        "input": [{"type": "text", "text": body, "text_elements": []}],
    });
    if let Some(model) = &config.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &config.reasoning_effort {
        params["effort"] = json!(effort);
    }
    params
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

    fn config() -> ResolvedCodexConfig {
        ResolvedCodexConfig {
            identity: rudder_d1_persistence::native_chat::config::RuntimeBindingIdentity {
                agent_id: "agent".into(),
                runtime_type: "codex_local".into(),
                host_id: "host".into(),
                profile_id: "managed-codex:agent:work".into(),
                workspace_binding_id: None,
                instructions_revision: "sha256:instructions".into(),
                capability_revision: "sha256:capabilities".into(),
            },
            executable: "/opt/codex".into(),
            cwd: "/workspace/project".into(),
            model: Some("custom/provider-model".into()),
            reasoning_effort: Some("high".into()),
            plan_mode: false,
            search_enabled: false,
            bypass_approvals_and_sandbox: false,
            count_subscription_usage_as_cost: true,
            profile: rudder_d1_persistence::native_chat::config::ManagedCodexProfile {
                id: "managed-codex:agent:work".into(),
                home: "/managed/codex-home".into(),
                native_managed: true,
            },
            operator_home: "/operator".into(),
            executable_search_path: "/usr/bin:/bin".into(),
            instruction_source_path: None,
            instruction_entry_file: "AGENTS.md".into(),
            instruction_content: Some("Use the selected profile.".into()),
            hermes: None,
            pi: None,
        }
    }

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

    #[test]
    fn requests_inherit_selected_codex_profile_policy_and_extensions() {
        let config = config();
        let thread = thread_params(&config);
        assert_eq!(thread["model"], "custom/provider-model");
        assert_eq!(thread["developerInstructions"], "Use the selected profile.");
        assert!(thread.get("approvalPolicy").is_none());
        assert!(thread.get("sandbox").is_none());
        assert_eq!(thread["config"]["web_search"], "disabled");

        let turn = turn_params("thread", "message", "hello", &config);
        assert_eq!(turn["effort"], "high");
        assert!(turn.get("approvalPolicy").is_none());
        assert!(turn.get("sandboxPolicy").is_none());
    }

    #[test]
    fn thread_request_preserves_enabled_agent_search_setting() {
        let mut config = config();
        config.search_enabled = true;
        let thread = thread_params(&config);
        assert_eq!(thread["config"]["web_search"], "live");
        assert!(thread["config"].get("mcp_servers").is_none());
        assert!(thread["config"].get("skills").is_none());
    }

    #[test]
    fn requests_omit_unset_model_and_effort_to_inherit_selected_profile() {
        let mut config = config();
        config.model = None;
        config.reasoning_effort = None;
        config.instruction_content = None;

        let thread = thread_params(&config);
        assert!(thread.get("model").is_none());
        assert!(thread.get("developerInstructions").is_none());

        let turn = turn_params("thread", "message", "hello", &config);
        assert!(turn.get("model").is_none());
        assert!(turn.get("effort").is_none());
    }
}
