use super::{ContextError, text};
use rudder_d1_persistence::agent_execution::AgentRunClaim;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn prepare(
    runtime: &str,
    claim: &AgentRunClaim,
    context: &Value,
    config: &mut Value,
    env: &BTreeMap<String, String>,
    skills: &str,
    prompt: &mut String,
) -> Result<(), ContextError> {
    if runtime == "openclaw_gateway" {
        let task = text(context, "taskId").or_else(|| text(context, "issueId"));
        let mut payload = config["payloadTemplate"]
            .get("rudder")
            .or_else(|| config["payloadTemplate"].get("paperclip"))
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let object = payload.as_object_mut().unwrap();
        for (key, value) in [
            ("runId", json!(claim.run_id)),
            ("orgId", json!(claim.organization_id)),
            ("agentId", json!(claim.agent_id)),
            ("agentName", json!(claim.agent_name)),
            ("scene", context["scene"].clone()),
            ("sourceRunId", context["sourceRunId"].clone()),
            ("delegationTask", context["delegationTask"].clone()),
            ("taskId", json!(task)),
            ("issueId", context["issueId"].clone()),
            (
                "issueIds",
                context
                    .get("issueIds")
                    .filter(|v| v.is_array())
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            ),
            ("wakeReason", context["wakeReason"].clone()),
            (
                "wakeCommentId",
                json!(text(context, "wakeCommentId").or_else(|| text(context, "commentId"))),
            ),
            ("approvalId", context["approvalId"].clone()),
            ("approvalStatus", context["approvalStatus"].clone()),
            ("apiUrl", json!(env.get("RUDDER_API_URL"))),
            ("workspace", context["rudderWorkspace"].clone()),
            ("workspaces", context["rudderWorkspaces"].clone()),
        ] {
            object.insert(key.into(), value);
        }
        if config["workspaceRuntime"].is_object()
            || context["rudderRuntimeServiceIntents"]
                .as_array()
                .is_some_and(|v| !v.is_empty())
        {
            let mut workspace = config
                .get("workspaceRuntime")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            workspace["services"] = context["rudderRuntimeServiceIntents"].clone();
            object.insert("workspaceRuntime".into(), workspace);
        }
        config["rudderPayload"] = payload;
        *prompt = if context["chatMode"] == true {
            text(context, "chatPrompt").unwrap_or_default().into()
        } else {
            openclaw_wake(context, env)
        };
    } else if runtime == "hermes_gateway" {
        config["rudderToolContextProjection"] = tool_projection(context)?;
        let base = if context["chatMode"] == true {
            text(context, "chatPrompt").map(str::to_owned)
        } else {
            None
        };
        let base = base.unwrap_or_else(|| {
            let mut lines = vec![
                "Rudder wake event for Hermes API Server.".into(),
                format!("run_id={}", claim.run_id),
                format!("agent_id={}", claim.agent_id),
                format!(
                    "wake_reason={}",
                    text(context, "wakeReason").unwrap_or("manual")
                ),
            ];
            if let Some(issue) = text(context, "issueId").or_else(|| text(context, "taskId")) {
                lines.push(format!("issue_id={issue}"));
            }
            lines.push(
                "Use the authenticated Rudder context for this run and return a concise result."
                    .into(),
            );
            lines.join("\n")
        });
        *prompt = if skills.is_empty() {
            base
        } else {
            format!("{base}\n\n{skills}")
        };
    }
    Ok(())
}

fn openclaw_wake(context: &Value, env: &BTreeMap<String, String>) -> String {
    let delegation = text(context, "scene") == Some("delegation");
    let heartbeat = text(context, "scene") == Some("heartbeat");
    let mut lines=vec![if delegation{"Rudder Delegation Run event for a cloud adapter."}else{"Rudder wake event for a cloud adapter."}.into(),String::new(),
        "HTTP compatibility mode: this runtime has not migrated to the CLI contract yet.".into(),String::new(),
        if delegation{"Run this independent bounded task with the target Agent's own runtime context. Do not inherit the source Run's transcript, session, workspace, credentials, environment variables, or arbitrary paths."}else{"Run this procedure now. Do not guess undocumented endpoints and do not ask for additional heartbeat docs."}.into()];
    if delegation {
        lines.extend([
            String::new(),
            "## Delegated Task".into(),
            text(context, "delegationTask").unwrap_or_default().into(),
            String::new(),
            format!(
                "Source Run {} is provenance only; use the target Agent's own context.",
                text(context, "sourceRunId").unwrap_or("unknown")
            ),
        ]);
    } else if heartbeat {
        lines.extend(["Translate the heartbeat instruction into the explicit HTTP workflow below. The listed HTTP endpoints override any CLI command guidance.".into(),String::new(),format!("<rudder_heartbeat_instruction>\n{}\n</rudder_heartbeat_instruction>",include_str!("rudder_agent_heartbeat_instruction.txt").trim())]);
    }
    lines.extend([
        String::new(),
        "Set these values in your run context:".into(),
    ]);
    for key in [
        "RUDDER_RUN_ID",
        "RUDDER_AGENT_ID",
        "RUDDER_ORG_ID",
        "RUDDER_API_URL",
        "RUDDER_TASK_ID",
        "RUDDER_DELEGATION_TASK",
        "RUDDER_WAKE_REASON",
        "RUDDER_WAKE_COMMENT_ID",
        "RUDDER_APPROVAL_ID",
        "RUDDER_APPROVAL_STATUS",
        "RUDDER_LINKED_ISSUE_IDS",
    ] {
        if let Some(value) = env.get(key).filter(|v| !v.is_empty()) {
            lines.push(format!("{key}={value}"));
        }
    }
    lines.extend(["RUDDER_API_KEY=<token from ~/.openclaw/workspace/rudder-claimed-api-key.json>".into(),String::new(),
        "Load RUDDER_API_KEY from ~/.openclaw/workspace/rudder-claimed-api-key.json (the token you saved after claim-api-key).".into(),String::new(),
        format!("api_base={}",env.get("RUDDER_API_URL").map(String::as_str).unwrap_or("<set RUDDER_API_URL>"))]);
    for (key, field) in [
        ("task_id", "taskId"),
        ("delegation_task", "delegationTask"),
        ("source_run_id", "sourceRunId"),
        ("issue_id", "issueId"),
        ("wake_reason", "wakeReason"),
        ("wake_comment_id", "wakeCommentId"),
        ("approval_id", "approvalId"),
        ("approval_status", "approvalStatus"),
    ] {
        let value = if field == "taskId" {
            text(context, field).or_else(|| text(context, "issueId"))
        } else {
            text(context, field)
        };
        lines.push(format!("{key}={}", value.unwrap_or_default()));
    }
    lines.extend([format!("linked_issue_ids={}",env.get("RUDDER_LINKED_ISSUE_IDS").map(String::as_str).unwrap_or_default()),String::new(),
        "HTTP compatibility rules:".into(),"- Use Authorization: Bearer $RUDDER_API_KEY on every API call.".into(),"- Use X-Rudder-Run-Id: $RUDDER_RUN_ID on every mutating API call.".into(),
        "- Use only /api endpoints listed below.".into(),"- Do NOT call guessed endpoints like /api/cloud-adapter/*, /api/cloud-adapters/*, /api/adapters/cloud/*, or /api/heartbeat.".into(),
        format!("- Treat HTTP compatibility as a narrow fallback. Preserve the Rudder {} semantics even when the transport is HTTP.",if delegation{"Delegation isolation and provenance-only source"}else if heartbeat{"heartbeat"}else{"wake"}),String::new()]);
    if delegation {
        lines.extend([
            "Workflow:".into(),
            "1) Execute only the bounded Delegation task above.".into(),
            "2) Return a concise result through the normal Run result path.".into(),
            String::new(),
            "Complete the delegated task in this run.".into(),
        ]);
    } else {
        lines.push(
            include_str!("openclaw-workflow.txt").replace(
                "{{issueIdHint}}",
                text(context, "taskId")
                    .or_else(|| text(context, "issueId"))
                    .unwrap_or_default(),
            ),
        );
    }
    lines.join("\n")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectedEvent {
    index: usize,
    kind: String,
    tool: Option<String>,
    tool_call_id: Option<String>,
    approval_id: Option<String>,
    status: Option<String>,
    content_hash: String,
    content_bytes: usize,
}
fn hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn tool_projection(context: &Value) -> Result<Value, ContextError> {
    let raw = context
        .get("rudderToolContext")
        .filter(|v| v.is_array())
        .or_else(|| context.get("transcript").filter(|v| v.is_array()))
        .and_then(Value::as_array);
    let Some(raw) = raw else {
        return Ok(
            json!({"version":"RUDDER_TOOL_CONTEXT_V1","transcriptHash":hash("[]"),"events":[]}),
        );
    };
    if raw.len() > 200 {
        return Err(ContextError::Invalid(
            "Canonical Hermes tool context exceeds the 200-event limit",
        ));
    }
    let bounded = |value: Option<&str>, limit: usize| {
        value
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(limit).collect::<String>())
    };
    let mut call_ids = BTreeSet::new();
    let mut projected = Vec::new();
    for (index, entry) in raw.iter().enumerate() {
        let kind = bounded(
            text(entry, "kind")
                .or_else(|| text(entry, "type"))
                .or_else(|| text(entry, "event")),
            64,
        )
        .unwrap_or_else(|| "event".into());
        let tool_call_id = bounded(
            text(entry, "toolCallId")
                .or_else(|| text(entry, "tool_call_id"))
                .or_else(|| text(entry, "id")),
            160,
        );
        if kind == "tool_call" {
            if let Some(id) = tool_call_id.as_ref() {
                call_ids.insert(id.clone());
            }
        }
        let content = text_from(
            entry
                .get("content")
                .or_else(|| entry.get("text"))
                .or_else(|| entry.get("output"))
                .unwrap_or(&Value::Null),
        )
        .unwrap_or_default();
        if content.len() > 64 * 1024 {
            return Err(ContextError::Invalid(
                "Canonical Hermes event exceeds the 64 KiB per-event limit",
            ));
        }
        projected.push(ProjectedEvent {
            index,
            kind,
            tool: bounded(text(entry, "tool").or_else(|| text(entry, "name")), 160),
            tool_call_id,
            approval_id: bounded(
                text(entry, "approvalId").or_else(|| text(entry, "approval_id")),
                160,
            ),
            status: bounded(text(entry, "status"), 64),
            content_hash: hash(&serde_json::to_string(&content).unwrap()),
            content_bytes: content.len(),
        });
    }
    if projected.iter().any(|entry| {
        matches!(entry.kind.as_str(), "tool_result" | "approval")
            && entry
                .tool_call_id
                .as_ref()
                .is_some_and(|id| !call_ids.contains(id))
    }) {
        return Err(ContextError::Invalid(
            "Canonical Hermes causal tool/approval pairing is incomplete",
        ));
    }
    let serialized = serde_json::to_string(&projected)
        .map_err(|_| ContextError::Invalid("Invalid Hermes tool context"))?;
    let value = json!({"version":"RUDDER_TOOL_CONTEXT_V1","transcriptHash":hash(&serialized),"events":serde_json::to_value(projected).unwrap()});
    let bytes = value.to_string().len();
    if bytes > 512 * 1024 || bytes.div_ceil(4) > 32_000 {
        return Err(ContextError::Invalid(
            "Canonical Hermes tool context exceeds its aggregate runtime limit",
        ));
    }
    Ok(value)
}
fn text_from(value: &Value) -> Option<String> {
    if let Some(value) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(value.into());
    }
    for key in ["output", "content", "text", "message", "summary", "delta"] {
        if let Some(found) = value.get(key).and_then(text_from) {
            return Some(found);
        }
    }
    if let Some(values) = value.get("content").and_then(Value::as_array) {
        let values = values.iter().filter_map(text_from).collect::<Vec<_>>();
        if !values.is_empty() {
            return Some(values.join("\n"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_unpaired_results_and_oversized_events() {
        assert!(tool_projection(&json!({"rudderToolContext":[{"kind":"tool_result","toolCallId":"unknown","content":"result"}]})).is_err());
        assert!(
            tool_projection(&json!({"transcript":[{"kind":"assistant","text":"x".repeat(65537)}]}))
                .is_err()
        );
    }
    #[test]
    fn projection_contains_hashes_without_raw_tool_secrets() {
        let value=tool_projection(&json!({"transcript":[{"kind":"tool_call","id":"t","text":"private-credential"},{"kind":"tool_result","toolCallId":"t","output":"private-result"}]})).unwrap();
        assert_eq!(value["events"].as_array().unwrap().len(), 2);
        assert!(!value.to_string().contains("private-credential"));
        assert!(!value.to_string().contains("private-result"));
    }
}
