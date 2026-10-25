//! Goal-started prompt and local Agent identity for the existing Claude run.
//!
//! The prompt template is captured from
//! `packages/agent-runtime-utils/src/server-utils.prompts.ts`; keep its
//! Goal-owned instructions in sync with that source. This module only handles
//! `goal_started` until the other existing Goal wake reasons are ported.

use crate::native_agent_jwt::{NativeAgentJwtConfig, sign_local_agent_jwt};
use rudder_d1_persistence::goal_run_resources::GoalStartedResources;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use thiserror::Error;

const GOAL_STARTED_PROMPT_TEMPLATE: &str = include_str!("goal_started_prompt_template.txt");

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GoalRunInvocation {
    pub prompt: String,
    pub env: BTreeMap<String, String>,
    pub instruction_context_sections: Vec<String>,
}

/// Trusted values resolved from the persisted wakeup and Agent configuration.
/// Paths and prompt context are never accepted from a public request body.
pub(crate) struct GoalRunContextInput<'a> {
    pub agent_id: &'a str,
    pub organization_id: &'a str,
    pub agent_name: &'a str,
    pub runtime_type: &'a str,
    pub run_id: &'a str,
    pub wake_reason: &'a str,
    pub invocation_source: &'a str,
    pub trigger_detail: Option<&'a str>,
    /// The non-secret Agent record selected under the runtime's trusted DB
    /// resolution. Explicit identity fields below override matching values.
    pub agent_context: &'a Value,
    /// The Node-shaped nested `context` map: persisted wake fields enriched
    /// with trusted workspace/runtime context by the worker.
    pub prompt_context: &'a Value,
    pub context_snapshot: &'a Value,
    pub configured_prompt_template: Option<&'a str>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum GoalRunContextError {
    #[error("Goal runtime currently supports only goal_started wakeups")]
    UnsupportedWakeReason,
    #[error("persisted Goal wake context is not an object")]
    InvalidWakeContext,
    #[error("resolved Agent prompt context is not an object")]
    InvalidAgentContext,
    #[error("resolved runtime prompt context is not an object")]
    InvalidPromptContext,
    #[error("local Agent JWT signing is unavailable")]
    AgentJwtUnavailable,
}

pub(crate) fn build_goal_run_invocation(
    input: &GoalRunContextInput<'_>,
    identity: &NativeAgentJwtConfig,
    resources: &GoalStartedResources,
) -> Result<GoalRunInvocation, GoalRunContextError> {
    if input.wake_reason != "goal_started" {
        return Err(GoalRunContextError::UnsupportedWakeReason);
    }
    if !input.context_snapshot.is_object() {
        return Err(GoalRunContextError::InvalidWakeContext);
    }
    if !input.agent_context.is_object() {
        return Err(GoalRunContextError::InvalidAgentContext);
    }
    if !input.prompt_context.is_object() {
        return Err(GoalRunContextError::InvalidPromptContext);
    }

    // Node starts with the durable wake snapshot and then adds the resolved
    // runtime scene facts. Keep the snapshot as the base so the Goal packet
    // remains present, while trusted runtime facts take precedence.
    let mut context = input.context_snapshot.clone();
    if let (Some(snapshot), Some(runtime)) =
        (context.as_object_mut(), input.prompt_context.as_object())
    {
        snapshot.extend(runtime.clone());
    }
    let wake_reason =
        nonempty_string(context.get("wakeReason")).unwrap_or_else(|| input.wake_reason.to_owned());
    let wake_source = nonempty_string(context.get("wakeSource"))
        .unwrap_or_else(|| input.invocation_source.to_owned());
    let trigger_detail = nonempty_string(context.get("wakeTriggerDetail"))
        .or_else(|| input.trigger_detail.map(str::to_owned));

    let context_object = context
        .as_object_mut()
        .expect("both persisted and runtime context were checked above");
    context_object.insert("wakeReason".to_owned(), Value::String(wake_reason.clone()));
    context_object.insert("wakeSource".to_owned(), Value::String(wake_source.clone()));
    if let Some(trigger_detail) = trigger_detail {
        context_object.insert(
            "wakeTriggerDetail".to_owned(),
            Value::String(trigger_detail),
        );
    }
    context_object.insert(
        "rudderScene".to_owned(),
        Value::String("heartbeat".to_owned()),
    );
    let workspace = context_object
        .entry("rudderWorkspace".to_owned())
        .or_insert_with(|| json!({}));
    if !workspace.is_object() {
        *workspace = json!({});
    }
    let workspace = workspace
        .as_object_mut()
        .expect("the Goal workspace context was normalized to an object");
    workspace.insert(
        "resourcesPrompt".to_owned(),
        Value::String(resources.org_resources_prompt.clone()),
    );
    workspace.insert(
        "orgResourcesPrompt".to_owned(),
        Value::String(resources.org_resources_prompt.clone()),
    );
    context_object.insert(
        "rudderResourcesPrompt".to_owned(),
        Value::String(resources.org_resources_prompt.clone()),
    );
    context_object.insert(
        "rudderStartupContext".to_owned(),
        resources.startup_context.clone(),
    );
    context_object.insert(
        "rudderStartupContextMetrics".to_owned(),
        resources.startup_context["metrics"].clone(),
    );
    context_object
        .entry("rudderResources".to_owned())
        .or_insert_with(|| json!([]));
    context_object
        .entry("rudderOrganizationResources".to_owned())
        .or_insert_with(|| json!([]));
    context_object
        .entry("rudderProjectResources".to_owned())
        .or_insert_with(|| json!([]));
    context_object
        .entry("rudderOrgNotes".to_owned())
        .or_insert_with(|| Value::String(String::new()));
    context_object
        .entry("rudderWorkspaces".to_owned())
        .or_insert_with(|| json!([]));
    let mut template = build_goal_started_prompt_template(&context);
    let (prompt_context, instruction_context_sections) =
        prepare_instruction_runtime_context(context);

    if let Some(configured) = input
        .configured_prompt_template
        .filter(|configured| !configured.trim().is_empty())
    {
        template = format!("{configured}\n\n{template}");
    }
    let mut agent = input.agent_context.clone();
    let agent = agent
        .as_object_mut()
        .expect("the resolved Agent context was checked above");
    agent.insert("id".to_owned(), Value::String(input.agent_id.to_owned()));
    agent.insert(
        "orgId".to_owned(),
        Value::String(input.organization_id.to_owned()),
    );
    agent.insert(
        "name".to_owned(),
        Value::String(input.agent_name.to_owned()),
    );
    agent.insert(
        "agentRuntimeType".to_owned(),
        Value::String(input.runtime_type.to_owned()),
    );
    let data = json!({
        "agentId": input.agent_id,
        "orgId": input.organization_id,
        "runId": input.run_id,
        "organization": {"id": input.organization_id},
        "agent": agent,
        "run": {
            "id": input.run_id,
            "source": wake_source.clone(),
            "wakeReason": wake_reason.clone(),
        },
        "context": prompt_context,
        "issue": null,
        "comment": null,
        "wakeReason": wake_reason.clone(),
        "wakeSource": wake_source.clone(),
    });
    template = render_template(&template, &data);

    let api_key = sign_local_agent_jwt(
        input.agent_id,
        input.organization_id,
        input.runtime_type,
        input.run_id,
        identity,
    )
    .ok_or(GoalRunContextError::AgentJwtUnavailable)?;
    let mut env = BTreeMap::new();
    env.insert("RUDDER_API_KEY".to_owned(), api_key);

    Ok(GoalRunInvocation {
        prompt: template,
        env,
        instruction_context_sections,
    })
}

fn prepare_instruction_runtime_context(mut context: Value) -> (Value, Vec<String>) {
    let Some(context_object) = context.as_object_mut() else {
        return (context, Vec::new());
    };
    let workspace_resources = context_object
        .get("rudderWorkspace")
        .and_then(Value::as_object)
        .and_then(|workspace| workspace.get("resourcesPrompt"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let workspace_org_resources = context_object
        .get("rudderWorkspace")
        .and_then(Value::as_object)
        .and_then(|workspace| workspace.get("orgResourcesPrompt"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let top_level_resources = context_object
        .get("rudderResourcesPrompt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let selected_resources = if !workspace_resources.is_empty() {
        workspace_resources.clone()
    } else if !workspace_org_resources.is_empty() {
        workspace_org_resources.clone()
    } else {
        top_level_resources.clone()
    };
    if selected_resources.is_empty() {
        return (context, Vec::new());
    }

    if let Some(workspace) = context_object
        .get_mut("rudderWorkspace")
        .and_then(Value::as_object_mut)
    {
        if workspace_resources == selected_resources {
            workspace.insert("resourcesPrompt".to_owned(), Value::String(String::new()));
        }
        if workspace_org_resources == selected_resources {
            workspace.insert(
                "orgResourcesPrompt".to_owned(),
                Value::String(String::new()),
            );
        }
    }
    if top_level_resources == selected_resources {
        context_object.insert(
            "rudderResourcesPrompt".to_owned(),
            Value::String(String::new()),
        );
    }
    (context, vec![selected_resources])
}

fn nonempty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn build_goal_started_prompt_template(context: &Value) -> String {
    let goal_id = first_prompt_path(context, &["id", "goalId"]);
    let goal_title = first_prompt_path(context, &["title", "goalTitle"]);
    let goal_outcome = first_prompt_path(
        context,
        &[
            "outcomeStatement",
            "goalOutcome",
            "outcome",
            "currentGoal.summary",
            "currentContract.outcomeStatement",
            "contract.outcomeStatement",
        ],
    );
    let current_contract =
        first_prompt_path(context, &["currentContract", "goalContract", "contract"])
            .or_else(|| first_prompt_path(context, &["goal"]));
    let current_plan = first_prompt_path(context, &["goalPlan", "currentPlan", "plan"]);
    let latest_checkpoint = first_prompt_path(
        context,
        &[
            "goalCheckpoint",
            "latestCheckpoint",
            "checkpoint",
            "checkpointFacts",
        ],
    );
    let continuation = continuation_prompt_path(context);
    [
        (
            "goalTitle",
            prompt_placeholder(goal_title.as_deref(), "Untitled Goal"),
        ),
        (
            "goalId",
            prompt_placeholder(
                goal_id.as_deref(),
                "Not provided in the wake context; request refreshed context.",
            ),
        ),
        (
            "goalOutcome",
            prompt_placeholder(goal_outcome.as_deref(), &missing_goal_fact("outcome")),
        ),
        (
            "currentContract",
            prompt_placeholder(current_contract.as_deref(), &missing_goal_fact("contract")),
        ),
        (
            "currentPlan",
            prompt_placeholder(current_plan.as_deref(), &missing_goal_fact("current Plan")),
        ),
        ("continuation", continuation),
        (
            "latestCheckpoint",
            prompt_placeholder(
                latest_checkpoint.as_deref(),
                &missing_goal_fact("latest checkpoint facts"),
            ),
        ),
        (
            "feedbackId",
            prompt_placeholder(
                first_prompt_path(context, &["feedback.id", "goalFeedback.id", "feedbackId"])
                    .as_deref(),
                &missing_goal_fact("feedback id"),
            ),
        ),
        (
            "feedbackBody",
            prompt_placeholder(
                first_prompt_path(
                    context,
                    &["feedback.body", "goalFeedback.body", "feedbackBody", "body"],
                )
                .as_deref(),
                &missing_goal_fact("feedback body"),
            ),
        ),
        (
            "decision",
            prompt_placeholder(
                first_prompt_path(context, &["decision.decision", "goalDecision.decision"])
                    .as_deref(),
                &missing_goal_fact("Goal change decision"),
            ),
        ),
        (
            "decisionStatus",
            prompt_placeholder(
                first_prompt_path(context, &["decision.status", "goalDecision.status"]).as_deref(),
                &missing_goal_fact("Goal change decision status"),
            ),
        ),
        (
            "decisionNote",
            prompt_placeholder(
                first_prompt_path(context, &["decision.note", "goalDecision.note"]).as_deref(),
                "No decision note was provided.",
            ),
        ),
    ]
    .into_iter()
    .fold(
        GOAL_STARTED_PROMPT_TEMPLATE.to_owned(),
        |template, (name, value)| {
            template.replace(&format!("{{{{context.goalRuntime.{name}}}}}"), &value)
        },
    )
}

fn continuation_prompt_path(context: &Value) -> String {
    let kind = first_prompt_path(
        context,
        &[
            "goalContinuation.kind",
            "continuation.kind",
            "currentContinuation.kind",
            "continuationKind",
        ],
    );
    let summary = first_prompt_path(
        context,
        &[
            "goalContinuation.summary",
            "continuation.summary",
            "currentContinuation.summary",
            "continuationSummary",
            "nextStepSummary",
        ],
    );
    if let (Some(kind), Some(summary)) = (&kind, &summary) {
        return format!(
            "{}: {}",
            prompt_placeholder(Some(kind), ""),
            prompt_placeholder(Some(summary), "")
        );
    }
    if let Some(value) = first_prompt_path(
        context,
        &[
            "goalContinuation",
            "continuation",
            "currentContinuation",
            "nextStep",
        ],
    ) {
        return prompt_placeholder(Some(&value), "");
    }
    prompt_placeholder(
        summary.as_deref().or(kind.as_deref()),
        &missing_goal_fact("continuation"),
    )
}

fn prompt_placeholder(path: Option<&str>, fallback: &str) -> String {
    path.map(|path| format!("{{{{context.{path}}}}}"))
        .unwrap_or_else(|| fallback.to_owned())
}

fn missing_goal_fact(fact: &str) -> String {
    format!(
        "Not provided in the wake context. If the Goal ID and `rudder_goal_context` are available, load managed Goal context once; otherwise report the missing {fact} and request refreshed context."
    )
}

fn first_prompt_path(root: &Value, suffixes: &[&str]) -> Option<String> {
    [
        "",
        "payload.",
        "wakePayload.",
        "wakeup.payload.",
        "heartbeat.payload.",
    ]
    .into_iter()
    .flat_map(|prefix| {
        suffixes.iter().flat_map(move |suffix| {
            [
                format!("{prefix}goal.{suffix}"),
                format!("{prefix}{suffix}"),
            ]
        })
    })
    .find(|path| value_at_path(root, path).is_some_and(has_prompt_value))
}

fn has_prompt_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        _ => true,
    }
}

fn value_at_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(root, |value, part| value.get(part))
}

fn javascript_json_stringify(value: &Value) -> String {
    let mut result = String::new();
    write_jsonb_value(&mut result, value);
    result
}

fn write_jsonb_value(output: &mut String, value: &Value) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned()))
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_jsonb_value(output, value);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            // PostgreSQL's JSONB text representation orders object keys by
            // byte length, then byte value. Node parses that order before
            // JSON.stringify renders prompt placeholders.
            entries.sort_by(|(left, _), (right, _)| {
                left.len()
                    .cmp(&right.len())
                    .then_with(|| left.as_bytes().cmp(right.as_bytes()))
            });
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned()));
                output.push(':');
                write_jsonb_value(output, value);
            }
            output.push('}');
        }
    }
}

fn render_template(template: &str, data: &Value) -> String {
    let mut rendered = String::with_capacity(template.len());
    let mut remaining = template;
    while let Some(open) = remaining.find("{{") {
        rendered.push_str(&remaining[..open]);
        let after_open = &remaining[open + 2..];
        let Some(close) = after_open.find("}}") else {
            rendered.push_str(&remaining[open..]);
            return rendered;
        };
        let token = &after_open[..close];
        let path = token.trim();
        if valid_template_path(path) {
            rendered.push_str(&resolve_path_value(data, path));
        } else {
            rendered.push_str(&remaining[open..open + 2 + close + 2]);
        }
        remaining = &after_open[close + 2..];
    }
    rendered.push_str(remaining);
    rendered
}

fn valid_template_path(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn resolve_path_value(data: &Value, path: &str) -> String {
    let Some(value) = value_at_path(data, path) else {
        return missing_path_value(path);
    };
    match value {
        Value::Null => missing_path_value(path),
        Value::String(value) if value.trim().is_empty() => missing_path_value(path),
        Value::String(value) => render_prompt_reference(value, path),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => javascript_json_stringify(value),
    }
}

fn missing_path_value(path: &str) -> String {
    if path == "issue.assigneeLabel" || path == "issue.reviewerLabel" {
        "none".to_owned()
    } else if path == "issue.createdAt" || path == "issue.updatedAt" {
        "unknown".to_owned()
    } else {
        String::new()
    }
}

fn render_prompt_reference(value: &str, path: &str) -> String {
    if is_short_reference(value) || !is_uuid(value) {
        return value.to_owned();
    }
    let Some(prefix) = prompt_reference_prefix(path) else {
        return value.to_owned();
    };
    let compact = value
        .replace('-', "")
        .chars()
        .take(8)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    format!("{prefix}_{compact}")
}

fn is_short_reference(value: &str) -> bool {
    let Some((prefix, suffix)) = value.split_once('_') else {
        return false;
    };
    prefix.len() == 3
        && prefix.bytes().all(|byte| byte.is_ascii_alphabetic())
        && (8..=32).contains(&suffix.len())
        && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_uuid(value: &str) -> bool {
    let parts = value.split('-').collect::<Vec<_>>();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .into_iter()
            .zip(parts.iter())
            .all(|(length, part)| {
                part.len() == length && part.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        && matches!(value.as_bytes().get(14).copied(), Some(b'1'..=b'5'))
        && value
            .as_bytes()
            .get(19)
            .copied()
            .is_some_and(|byte| matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'))
}

fn prompt_reference_prefix(path: &str) -> Option<&'static str> {
    let leaf = path.rsplit('.').next()?.to_ascii_lowercase();
    for (suffix, prefix) in [
        ("agentid", "agt"),
        ("userid", "usr"),
        ("runid", "run"),
        ("messageid", "msg"),
        ("projectid", "prj"),
        ("goalid", "gol"),
        ("commentid", "cmt"),
        ("issueid", "iss"),
        ("chatid", "cht"),
        ("conversationid", "cht"),
        ("parentid", "iss"),
    ] {
        if leaf.ends_with(suffix) {
            return Some(prefix);
        }
    }
    let base = if leaf == "id" {
        path.rsplit('.').nth(1)?.to_ascii_lowercase()
    } else if leaf.ends_with("id") {
        leaf.strip_suffix("id")?.to_owned()
    } else {
        leaf
    };
    match base.as_str() {
        "agent" => Some("agt"),
        "chat" | "conversation" => Some("cht"),
        "comment" => Some("cmt"),
        "run" => Some("run"),
        "message" => Some("msg"),
        "project" => Some("prj"),
        "goal" => Some("gol"),
        "user" => Some("usr"),
        "issue" | "parent" => Some("iss"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_agent_jwt::{NativeAgentJwtConfig, verify};

    fn input<'a>(
        snapshot: &'a Value,
        prompt_context: &'a Value,
        agent_context: &'a Value,
    ) -> GoalRunContextInput<'a> {
        GoalRunContextInput {
            agent_id: "50000000-0000-4000-8000-000000000001",
            organization_id: "10000000-0000-4000-8000-000000000001",
            agent_name: "Release Operator 🧪",
            runtime_type: "claude_local",
            run_id: "90000000-0000-4000-8000-000000000001",
            wake_reason: "goal_started",
            invocation_source: "on_demand",
            trigger_detail: Some("system"),
            agent_context,
            prompt_context,
            context_snapshot: snapshot,
            configured_prompt_template: None,
        }
    }

    fn identity() -> NativeAgentJwtConfig {
        NativeAgentJwtConfig {
            secret: "local-agent-jwt-secret".to_owned(),
            issuer: "rudder".to_owned(),
            audience: "rudder-api".to_owned(),
        }
    }

    fn resources() -> GoalStartedResources {
        let org_resources_prompt =
            "<recent_rudder_context>\n今天可以继续。\n</recent_rudder_context>".to_owned();
        let total_chars = org_resources_prompt.encode_utf16().count();
        GoalStartedResources {
            org_resources_prompt: org_resources_prompt.clone(),
            startup_context: json!({
                "version":"agent-startup-context/v1",
                "sections":["daily_memory","organization_members","recent_issues","recent_chats"],
                "sourceRefs":[],
                "markdown":org_resources_prompt,
                "metrics":{
                    "version":"agent-startup-context/v1",
                    "totalChars":total_chars,
                    "limitChars":12000,
                    "recentIssuesCount":0,
                    "recentChatsCount":0,
                    "omittedIssues":0,
                    "omittedChats":0
                },
                "omissions":[]
            }),
        }
    }

    fn fixture_prompt_context() -> Value {
        json!({
            "customFact": "context from the resolved runtime",
            "rudderScene": "heartbeat",
            "rudderWorkspace": {
                "cwd": "/private/agent-home",
                "source": "agent_home",
                "mode": "agent_default",
                "strategy": null,
                "projectId": null,
                "workspaceId": null,
                "repoUrl": null,
                "repoRef": null,
                "branchName": null,
                "worktreePath": null,
                "executionWorkspaceCwd": "/private/agent-home",
                "executionWorkspaceSource": "agent_home",
                "agentHome": "/private/agent-home",
                "agentRoot": "/private/agent-home",
                "instructionsDir": "/private/agent-home/instructions",
                "memoryDir": "/private/agent-home/memory",
                "lifeDir": "/private/agent-home/life",
                "agentSkillsDir": "/private/agent-home/skills",
                "orgWorkspaceRoot": "/private/org-workspace",
                "orgAgentsDir": "/private/org-workspace/agents",
                "orgSkillsDir": "/private/org-workspace/skills",
                "projectLibraryRoot": null,
                "projectLibraryRelativePath": null
            },
            "rudderWorkspaces": []
        })
    }

    fn fixture_agent_context() -> Value {
        json!({
            "id": "untrusted-agent-id",
            "orgId": "untrusted-org-id",
            "name": "untrusted name",
            "role": "Release operator",
            "status": "active",
            "workspaceKey": "release-operator",
            "agentRuntimeType": "untrusted-runtime",
            "agentRuntimeConfig": {"promptTemplate":"must not leak into agent context"}
        })
    }

    #[test]
    fn renders_goal_started_invocation_from_persisted_context_and_signs_agent_identity() {
        let context: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/goal-started-prompt-typescript.json"
        ))
        .unwrap();
        let fixture = &context["contextSnapshot"];
        let prompt_context = &context["promptContext"];
        let agent_context = &context["agentContext"];
        let input = input(fixture, prompt_context, agent_context);
        let identity = identity();
        let invocation = build_goal_run_invocation(&input, &identity, &resources()).unwrap();
        assert_eq!(
            invocation.prompt,
            context["defaultPrompt"].as_str().unwrap()
        );
        assert_eq!(
            serde_json::to_value(&invocation.instruction_context_sections).unwrap(),
            context["instructionContextSections"]
        );
        assert_eq!(
            invocation.instruction_context_sections,
            ["<recent_rudder_context>\n今天可以继续。\n</recent_rudder_context>"]
        );
        assert!(!invocation.prompt.contains("今天可以继续"));
        assert!(
            invocation
                .prompt
                .contains("agent agt_50000000 (Release Operator 🧪)")
        );
        assert_eq!(
            invocation
                .env
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["RUDDER_API_KEY"]
        );
        let token = invocation.env.get("RUDDER_API_KEY").unwrap();
        let token_identity = verify(token, &identity, 0.0).unwrap();
        assert_eq!(token_identity.agent_id, input.agent_id);
        assert_eq!(token_identity.org_id, input.organization_id);
        assert_eq!(token_identity.adapter_type, input.runtime_type);
        assert_eq!(token_identity.run_id, input.run_id);
    }

    #[test]
    fn appends_the_goal_runtime_rail_to_a_custom_agent_template() {
        let context: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/goal-started-prompt-typescript.json"
        ))
        .unwrap();
        let fixture = &context["contextSnapshot"];
        let prompt_context = &context["promptContext"];
        let agent_context = &context["agentContext"];
        let mut input = input(fixture, prompt_context, agent_context);
        input.configured_prompt_template =
            Some("Follow the careful operator persona for {{agent.name}}.");
        let invocation = build_goal_run_invocation(&input, &identity(), &resources()).unwrap();
        assert_eq!(invocation.prompt, context["customPrompt"].as_str().unwrap());
    }

    #[test]
    fn clears_selected_resource_aliases_from_custom_template_context() {
        let snapshot = json!({"goalId":"30000000-0000-4000-8000-000000000001"});
        let mut prompt_context = fixture_prompt_context();
        prompt_context["customFact"] = json!("context from the resolved runtime");
        let agent_context = fixture_agent_context();
        let mut input = input(&snapshot, &prompt_context, &agent_context);
        input.configured_prompt_template = Some(
            "{{context.customFact}}|{{context.rudderWorkspace.resourcesPrompt}}|{{context.rudderWorkspace.orgResourcesPrompt}}|{{context.rudderResourcesPrompt}}|{{agent.role}}|{{run.source}}|{{context.wakeTriggerDetail}}",
        );
        let invocation = build_goal_run_invocation(&input, &identity(), &resources()).unwrap();
        assert!(
            invocation
                .prompt
                .starts_with("context from the resolved runtime||||")
        );
        assert!(
            invocation
                .prompt
                .contains("|Release operator|on_demand|system\n\n")
        );
        assert_eq!(
            invocation.instruction_context_sections,
            [resources().org_resources_prompt]
        );
    }

    #[test]
    fn rejects_other_goal_wake_reasons_until_their_prompt_contract_is_ported() {
        let snapshot = json!({"goalId":"30000000-0000-4000-8000-000000000001"});
        let prompt_context = fixture_prompt_context();
        let agent_context = fixture_agent_context();
        let mut input = input(&snapshot, &prompt_context, &agent_context);
        input.wake_reason = "goal_feedback";
        assert_eq!(
            build_goal_run_invocation(&input, &identity(), &resources()).unwrap_err(),
            GoalRunContextError::UnsupportedWakeReason
        );
    }

    #[test]
    fn json_placeholder_serialization_matches_jsonb_prompt_object_order() {
        let snapshot = json!({
            "goal": {
                "id": "g",
                "title": "t",
                "criteria": [],
                "description": null,
                "objectiveMode": "outcome",
                "actionDeadline": null,
                "contractRevision": 3,
                "autonomyEnvelope": {},
                "evaluationPolicy": {},
                "humanAuthorities": [],
                "outcomeStatement": "o",
                "evaluationDeadline": null
            }
        });
        assert_eq!(
            javascript_json_stringify(value_at_path(&snapshot, "goal").unwrap()),
            "{\"id\":\"g\",\"title\":\"t\",\"criteria\":[],\"description\":null,\"objectiveMode\":\"outcome\",\"actionDeadline\":null,\"autonomyEnvelope\":{},\"contractRevision\":3,\"evaluationPolicy\":{},\"humanAuthorities\":[],\"outcomeStatement\":\"o\",\"evaluationDeadline\":null}"
        );
    }

    #[test]
    fn keeps_unicode_template_substitution_and_reference_shortening() {
        let rendered = render_template(
            "{{agent.id}} {{agent.name}} {{context.goalId}} {{context.unknown}}",
            &json!({
                "agent":{"id":"50000000-0000-4000-8000-000000000001","name":"山田 🧭"},
                "context":{"goalId":"30000000-0000-4000-8000-000000000001"}
            }),
        );
        assert_eq!(rendered, "agt_50000000 山田 🧭 gol_30000000 ");
    }
}
