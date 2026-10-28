//! Observable Agent-mode contract of hermes-paperclip-adapter@0.3.0 selected
//! by the Node registry. Native Chat ACP is intentionally a separate runtime.
use super::{AgentRunContextHost, text};
use rudder_d1_persistence::agent_execution::AgentRunClaim;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::PathBuf};

const VALID_PROVIDERS: &[&str] = &[
    "auto",
    "openrouter",
    "nous",
    "openai-codex",
    "copilot",
    "copilot-acp",
    "anthropic",
    "huggingface",
    "zai",
    "kimi-coding",
    "minimax",
    "minimax-cn",
    "kilocode",
];

pub(super) fn prepare(
    claim: &AgentRunClaim,
    config: &mut Value,
    host: &AgentRunContextHost,
    env: &mut BTreeMap<String, String>,
) -> (String, PathBuf) {
    let model = text(config, "model")
        .unwrap_or("anthropic/claude-sonnet-4")
        .to_owned();
    let detected = if config
        .get("provider")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        None
    } else {
        fs::read_to_string(host.operator_home.join(".hermes/config.yaml"))
            .ok()
            .and_then(|raw| detect_model(&raw))
    };
    let provider = resolve_provider(text(config, "provider"), detected.as_ref(), &model);
    config["model"] = json!(model);
    if provider == "auto" {
        if let Some(config) = config.as_object_mut() {
            config.remove("provider");
        }
    } else {
        config["provider"] = json!(provider);
    }
    if text(config, "toolsets").is_none() {
        if let Some(values) = config["enabledToolsets"]
            .as_array()
            .filter(|values| values.iter().all(|v| v.is_string()))
        {
            config["toolsets"] = json!(
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
    }
    let api = config
        .get("paperclipApiUrl")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| host.environment.get("PAPERCLIP_API_URL").cloned())
        .unwrap_or_else(|| "http://127.0.0.1:3100/api".into());
    let api = if api.ends_with("/api") {
        api
    } else {
        format!("{}/api", api.trim_end_matches('/'))
    };
    let task = config
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let comment = config
        .get("commentId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let vars = json!({"agentId":claim.agent_id,"agentName":if claim.agent_name.is_empty(){"Hermes Agent"}else{&claim.agent_name},
        "companyId":claim.organization_id,"companyName":config["companyName"],"runId":claim.run_id,
        "taskId":task,"taskTitle":config["taskTitle"],"taskBody":config["taskBody"],"commentId":comment,
        "wakeReason":config["wakeReason"],"projectName":config["projectName"],"paperclipApiUrl":api});
    let mut prompt = text(config, "promptTemplate")
        .unwrap_or(include_str!("hermes-legacy-prompt.txt"))
        .to_owned();
    for (key, present) in [
        ("taskId", !task.is_empty()),
        ("noTask", task.is_empty()),
        ("commentId", !comment.is_empty()),
    ] {
        prompt = conditional_sections(&prompt, key, present);
    }
    prompt = render_flat(&prompt, &vars);
    let runtime_host = host
        .environment
        .get("PAPERCLIP_LISTEN_HOST")
        .or_else(|| host.environment.get("HOST"))
        .cloned()
        .unwrap_or_else(|| "localhost".into());
    let runtime_host = match runtime_host.trim() {
        "" | "0.0.0.0" | "::" => "localhost".into(),
        value if value.contains(':') && !value.starts_with('[') && !value.ends_with(']') => {
            format!("[{value}]")
        }
        value => value.to_owned(),
    };
    let runtime_port = host
        .environment
        .get("PAPERCLIP_LISTEN_PORT")
        .or_else(|| host.environment.get("PORT"))
        .cloned()
        .unwrap_or_else(|| "3100".into());
    let runtime_api = host
        .environment
        .get("PAPERCLIP_RUNTIME_API_URL")
        .or_else(|| host.environment.get("PAPERCLIP_API_URL"))
        .cloned()
        .unwrap_or_else(|| format!("http://{runtime_host}:{runtime_port}"));
    env.insert("PAPERCLIP_AGENT_ID".into(), claim.agent_id.clone());
    env.insert("PAPERCLIP_COMPANY_ID".into(), claim.organization_id.clone());
    env.insert("PAPERCLIP_API_URL".into(), runtime_api);
    env.insert("PAPERCLIP_RUN_ID".into(), claim.run_id.clone());
    if !task.is_empty() {
        env.insert("PAPERCLIP_TASK_ID".into(), task.into());
    }
    // The legacy adapter applies its own user env last. Do not replace HOME
    // or a custom Paperclip alias with Native Chat's managed profile policy.
    for (key, value) in config["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            env.insert(key.clone(), value.into());
        }
    }
    let cwd = text(config, "cwd")
        .or_else(|| text(config, "workspaceDir"))
        .map(PathBuf::from)
        .unwrap_or_else(|| host.process_cwd.clone());
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        host.process_cwd.join(cwd)
    };
    (prompt, cwd)
}

fn conditional_sections(template: &str, key: &str, present: bool) -> String {
    let open = format!("{{{{#{key}}}}}");
    let close = format!("{{{{/{key}}}}}");
    let mut value = template.to_owned();
    while let Some(start) = value.find(&open) {
        let after = start + open.len();
        let Some(relative) = value[after..].find(&close) else {
            break;
        };
        let end = after + relative;
        let body = if present {
            value[after..end].to_owned()
        } else {
            String::new()
        };
        value.replace_range(start..end + close.len(), &body);
    }
    value
}
fn render_flat(template: &str, vars: &Value) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let value = after[..end]
            .trim()
            .split('.')
            .try_fold(vars, |value, key| value.get(key));
        if let Some(value) = value {
            match value {
                Value::String(text) => out.push_str(text),
                Value::Null => (),
                value => out.push_str(&value.to_string()),
            }
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}
fn detect_model(content: &str) -> Option<(String, String)> {
    let mut active = false;
    let mut model = String::new();
    let mut provider = String::new();
    for line in content.lines() {
        let trimmed = line.trim_end();
        let indent = line.len() - line.trim_start().len();
        if trimmed == "model:" && indent == 0 {
            active = true;
            continue;
        }
        if active && indent == 0 && !trimmed.is_empty() && !trimmed.starts_with('#') {
            active = false;
        }
        if active {
            if let Some((key, value)) = trimmed.trim_start().split_once(':') {
                let value = value
                    .split('#')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .trim_matches(['\'', '"']);
                match key.trim() {
                    "default" => model = value.into(),
                    "provider" => provider = value.into(),
                    _ => (),
                }
            }
        }
    }
    if model.is_empty() {
        None
    } else {
        Some((model, provider))
    }
}
fn resolve_provider(
    explicit: Option<&str>,
    detected: Option<&(String, String)>,
    model: &str,
) -> String {
    if let Some(provider) = explicit.filter(|value| VALID_PROVIDERS.contains(value)) {
        return provider.into();
    }
    if let Some((detected_model, provider)) = detected {
        if detected_model.eq_ignore_ascii_case(model)
            && VALID_PROVIDERS.contains(&provider.as_str())
        {
            return provider.clone();
        }
    }
    let lower = model.to_ascii_lowercase();
    let bare = lower.rsplit('/').next().unwrap_or(&lower);
    for (prefix, provider) in [
        ("gpt-4", "openai-codex"),
        ("gpt-5", "copilot"),
        ("o1-", "openai-codex"),
        ("o3-", "openai-codex"),
        ("o4-", "openai-codex"),
        ("claude", "anthropic"),
        ("gemini", "auto"),
        ("hermes-", "nous"),
        ("glm-", "zai"),
        ("moonshot", "kimi-coding"),
        ("kimi", "kimi-coding"),
        ("minimax", "minimax"),
        ("deepseek", "auto"),
        ("llama", "auto"),
        ("qwen", "auto"),
        ("mistral", "auto"),
        ("huggingface/", "huggingface"),
    ] {
        if bare.starts_with(prefix) {
            return provider.into();
        }
    }
    "auto".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mismatched_model_does_not_reuse_another_models_provider() {
        let detected = detect_model("model:\n  default: gpt-5.4\n  provider: copilot\n").unwrap();
        assert_eq!(
            resolve_provider(None, Some(&detected), "anthropic/claude-sonnet-4"),
            "anthropic"
        );
    }
    #[test]
    fn conditional_prompt_retains_only_the_current_legacy_branch() {
        let value = conditional_sections(
            "{{#taskId}}task {{taskId}}{{/taskId}} {{#noTask}}idle{{/noTask}}",
            "taskId",
            false,
        );
        assert_eq!(conditional_sections(&value, "noTask", true), " idle");
    }
    #[test]
    fn flat_legacy_ids_stay_full_opaque_values() {
        assert_eq!(
            render_flat(
                "{{agentId}}/{{taskId}}",
                &json!({"agentId":"10000000-0000-4000-8000-000000000001","taskId":"TASK-7"})
            ),
            "10000000-0000-4000-8000-000000000001/TASK-7"
        );
    }
}
