use super::{Result, invalid, unsupported};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

const DEFAULT_CODEX_MODEL: &str = "gpt-5.6-luna";
const DEFAULT_CODEX_EFFORT: &str = "medium";

#[derive(Clone)]
pub(super) struct RuntimeSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub plan_mode: bool,
    pub search_enabled: bool,
    pub cwd_override: Option<PathBuf>,
    pub profile_id: String,
    pub command: Option<PathBuf>,
    pub capability_revision_input: Value,
}

pub(super) fn parse_agent_config(
    config: Value,
    chat_model: Option<String>,
    chat_effort: Option<String>,
    chat_plan_mode: bool,
    operator_home: &Path,
) -> Result<RuntimeSettings> {
    let object = config
        .as_object()
        .ok_or_else(|| invalid("Agent runtime configuration must be an object"))?;

    const SUPPORTED: &[&str] = &[
        "model",
        "modelReasoningEffort",
        "reasoningEffort",
        "planMode",
        "cwd",
        "command",
        "args",
        "extraArgs",
        "profileId",
        "instructionsBundleMode",
        "instructionsRootPath",
        "instructionsEntryFile",
        "instructionsFilePath",
        "promptTemplate",
        "env",
        "environment",
        "skills",
        "enabledSkills",
        "mcpServers",
        "capabilities",
        "browser",
        "computer",
        "search",
        "dangerouslyBypassApprovalsAndSandbox",
        "approvalPolicy",
        "sandboxMode",
        "workspacePolicy",
    ];
    if object.keys().any(|key| !SUPPORTED.contains(&key.as_str())) {
        return Err(unsupported(
            "an unrecognized Agent runtime setting is present",
        ));
    }

    for key in ["env", "environment"] {
        if let Some(value) = object.get(key)
            && !matches!(value, Value::Null)
            && value != &json!({})
        {
            return Err(unsupported(
                "custom environment values and Secret references are not enabled",
            ));
        }
    }
    for key in ["skills", "enabledSkills", "mcpServers", "capabilities"] {
        if let Some(value) = object.get(key)
            && !is_empty_collection(value)
        {
            return Err(unsupported(
                "configured optional skills or MCP capabilities are not enabled",
            ));
        }
    }
    for key in ["browser", "computer", "search"] {
        if let Some(value) = object.get(key)
            && !(if key == "search" {
                matches!(value, Value::Null | Value::Bool(false))
            } else {
                is_disabled(value)
            })
        {
            return Err(unsupported(
                "configured browser, computer, or search capability is not enabled",
            ));
        }
    }
    if optional_string(object, "promptTemplate")?.is_some() {
        return Err(unsupported(
            "Agent prompt templates are not supported by native Chat yet",
        ));
    }
    for key in ["approvalPolicy", "sandboxMode", "workspacePolicy"] {
        if object.contains_key(key) {
            return Err(unsupported(
                "custom approval, sandbox, or workspace policy is not enabled",
            ));
        }
    }
    match object.get("dangerouslyBypassApprovalsAndSandbox") {
        None | Some(Value::Bool(false)) => (),
        Some(Value::Bool(true)) => {
            return Err(unsupported("approval or sandbox bypass is not enabled"));
        }
        Some(_) => return Err(invalid("approval bypass setting must be boolean")),
    }
    for key in ["args", "extraArgs"] {
        if let Some(value) = object.get(key)
            && !value.as_array().is_some_and(Vec::is_empty)
        {
            return Err(unsupported(
                "custom Codex command arguments are not enabled",
            ));
        }
    }

    let configured_model = configured_model(object)?;
    let model = chat_model
        .filter(|value| !value.trim().is_empty())
        .or(configured_model)
        .unwrap_or_else(|| DEFAULT_CODEX_MODEL.to_owned());
    validate_model(&model)?;

    let model_effort = optional_string(object, "modelReasoningEffort")?;
    let legacy_effort = optional_string(object, "reasoningEffort")?;
    if model_effort.is_some() && legacy_effort.is_some() && model_effort != legacy_effort {
        return Err(invalid("conflicting reasoning effort settings"));
    }
    let configured_effort = model_effort.or(legacy_effort);
    let effort = chat_effort
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .or(configured_effort)
        .unwrap_or_else(|| DEFAULT_CODEX_EFFORT.to_owned());
    validate_effort(&effort)?;

    if let Some(value) = object.get("planMode")
        && value.as_bool() != Some(chat_plan_mode)
    {
        return Err(invalid("Agent and Chat plan settings conflict"));
    }

    // The pinned App Server turn/start schema has no planning-mode field.
    // Reject before admission instead of silently executing a planning request
    // as a normal turn. Enable only with a verified native protocol mapping.
    if chat_plan_mode {
        return Err(unsupported("planning mode has no verified native protocol mapping"));
    }

    let cwd_override = optional_string(object, "cwd")?
        .map(|value| resolve_configured_path(&value, operator_home))
        .transpose()?;
    let profile_id = optional_string(object, "profileId")?.unwrap_or_else(|| "default".into());
    validate_profile_id(&profile_id)?;
    let command = optional_string(object, "command")?
        .map(|value| PathBuf::from(value.trim()))
        .map(|path| {
            if !path.is_absolute() {
                return Err(unsupported(
                    "configured Codex command must be an absolute path",
                ));
            }
            Ok(path)
        })
        .transpose()?;
    validate_instruction_settings(object)?;

    let search_enabled = object.get("search") == Some(&Value::Bool(true));

    let capability_revision_input = json!({
        "model": model,
        "effort": effort,
        "planMode": chat_plan_mode,
        "cwd": cwd_override.as_ref().map(|path| path.to_string_lossy().to_string()),
        "profileId": profile_id,
        "command": command.as_ref().map(|path| path.to_string_lossy().to_string()),
        "searchEnabled": search_enabled,
    });

    Ok(RuntimeSettings {
        model: Some(model),
        effort: Some(effort),
        plan_mode: chat_plan_mode,
        search_enabled,
        cwd_override,
        profile_id,
        command,
        capability_revision_input,
    })
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else if trimmed.len() > 4_096 || trimmed.chars().any(char::is_control) {
                Err(invalid("Agent runtime setting has an invalid string value"))
            } else {
                Ok(Some(trimmed.to_owned()))
            }
        }
        Some(_) => Err(invalid("Agent runtime setting has an invalid value type")),
    }
}

fn configured_model(object: &Map<String, Value>) -> Result<Option<String>> {
    match object.get("model") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            validate_model(value)?;
            Ok(Some(value.clone()))
        }
        Some(_) => Err(invalid("Codex model identifier is invalid")),
    }
}

fn validate_model(model: &str) -> Result<()> {
    if model.trim().is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        return Err(invalid("Codex model identifier is invalid"));
    }
    Ok(())
}

fn validate_effort(effort: &str) -> Result<()> {
    if !matches!(
        effort,
        "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    ) {
        return Err(unsupported(
            "Codex reasoning effort is not a supported App Server level",
        ));
    }
    Ok(())
}

fn validate_profile_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || matches!(value, "." | "..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(invalid("managed profile identity is invalid"));
    }
    Ok(())
}

fn resolve_configured_path(value: &str, operator_home: &Path) -> Result<PathBuf> {
    let path = if value == "~" {
        operator_home.to_path_buf()
    } else if let Some(tail) = value.strip_prefix("~/") {
        operator_home.join(tail)
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(unsupported(
            "configured cwd must be an absolute normalized path",
        ));
    }
    Ok(path)
}

fn is_empty_collection(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Array(values) => values.is_empty(),
        Value::Object(values) => values.is_empty(),
        _ => false,
    }
}

fn is_disabled(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Object(object) => {
            object.len() == 1 && object.get("enabled") == Some(&Value::Bool(false))
        }
        _ => false,
    }
}

fn validate_instruction_settings(object: &Map<String, Value>) -> Result<()> {
    if let Some(value) = object.get("instructionsBundleMode") {
        match value {
            Value::Null => (),
            Value::String(mode) if matches!(mode.as_str(), "managed" | "external") => (),
            _ => return Err(invalid("instruction bundle mode is invalid")),
        }
    }
    for key in [
        "instructionsRootPath",
        "instructionsFilePath",
        "instructionsEntryFile",
    ] {
        let value = optional_string(object, key)?;
        if key == "instructionsEntryFile"
            && value.as_deref().is_some_and(|path| {
                Path::new(path).is_absolute()
                    || path.contains('\\')
                    || Path::new(path)
                        .components()
                        .any(|component| matches!(component, std::path::Component::ParentDir))
            })
        {
            return Err(invalid(
                "instruction entry file must stay within its bundle",
            ));
        }
        if key == "instructionsFilePath" {
            let relative = value
                .as_deref()
                .is_some_and(|path| !Path::new(path).is_absolute());
            let cwd = optional_string(object, "cwd")?;
            if relative
                && cwd
                    .as_deref()
                    .is_none_or(|path| !Path::new(path).is_absolute())
            {
                return Err(invalid(
                    "relative legacy instruction path requires an absolute Agent cwd",
                ));
            }
        }
    }
    Ok(())
}
