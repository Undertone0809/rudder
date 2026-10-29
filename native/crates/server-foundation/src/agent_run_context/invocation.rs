use super::{prompts, text};
use crate::goal_run_context::prepare_instruction_runtime_context;
use rudder_d1_persistence::agent_execution::AgentRunClaim;
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

pub(super) fn compose(
    claim: &AgentRunClaim,
    config: &Value,
    context: &Value,
    agent: &Value,
    instruction_text: &str,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> String {
    let runtime = claim.runtime_type.as_str();
    if !matches!(
        runtime,
        "claude_local"
            | "codex_local"
            | "cursor"
            | "opencode_local"
            | "pi_local"
            | "hermes_local"
            | "http"
            | "openclaw_gateway"
            | "hermes_gateway"
    ) {
        if context["chatMode"] == true {
            return text(context, "chatPrompt").unwrap_or_default().into();
        }
        if text(context, "scene").or_else(|| text(context, "rudderScene")) == Some("delegation")
            && let Some(task) = text(context, "delegationTask")
        {
            return format!(
                "You are agent {} ({}) running an independent Rudder Delegation Run.\n\nSource Run {} and Source Agent {} are provenance only. Do not inherit the source Run's transcript, session, workspace, credentials, environment variables, or arbitrary paths. Use the target Agent's own runtime, workspace, instructions, and skills.\n\n## Delegated Task\n\n{task}\n\nComplete only this bounded task and report the result through the normal Run evidence path.",
                claim.agent_id,
                claim.agent_name,
                text(context, "sourceRunId").unwrap_or("unknown"),
                text(context, "sourceAgentId").unwrap_or("unknown")
            );
        }
        return String::new();
    }
    let (prompt_context, _) = prepare_instruction_runtime_context(context.clone());
    let rendered = prompts::render(config, &prompt_context, agent, &claim.run_id);
    let bootstrap = if !can_resume(claim, cwd) {
        text(config, "bootstrapPromptTemplate")
            .map(|template| prompts::render_raw(template, &prompt_context, agent, &claim.run_id))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let handoff = text(context, "rudderSessionHandoffMarkdown").unwrap_or_default();
    let env_note = if runtime == "cursor" {
        let keys = env
            .keys()
            .filter(|key| key.starts_with("RUDDER_"))
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "Rudder runtime note:\nThe following RUDDER_* environment variables are available in this run: {keys}\nDo not assume these variables are missing without checking your shell environment."
        )
    } else {
        String::new()
    };
    let frame = if matches!(runtime, "claude_local" | "pi_local") {
        ""
    } else {
        instruction_text
    };
    [
        frame,
        bootstrap.as_str(),
        handoff,
        env_note.as_str(),
        rendered.as_str(),
    ]
    .into_iter()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
}
fn can_resume(claim: &AgentRunClaim, cwd: &Path) -> bool {
    claim.session_reuse_scope != "none"
        && rudder_native_chat_executor::agent_run::agent_session_for_workspace(
            &claim.runtime_type,
            claim.session_params_before.as_ref(),
            claim.session_id_before.as_deref(),
            cwd,
        )
        .is_some()
}
