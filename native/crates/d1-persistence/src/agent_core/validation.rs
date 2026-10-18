//! Schemas for the independently migrated Agent endpoints. Absent root, null,
//! empty strings and unknown fields retain the exact public Zod distinction.
use super::{
    AgentCoreError, AgentCreateInstructionsBundle, AgentCreateIntelligenceDefaults,
    AgentCreateNodeOwned, AgentCreatePermissions, AgentCreateRequest,
    common::{Result, Tx, js_trim, uuid_like},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
};

pub(super) const MAX_INSTRUCTION_FILES: usize = 128;
pub(super) const MAX_INSTRUCTION_PATH_BYTES: usize = 512;
pub(super) const MAX_INSTRUCTION_FILE_BYTES: usize = 256 * 1024;
pub(super) const MAX_INSTRUCTION_BUNDLE_BYTES: usize = 2 * 1024 * 1024;
const MAX_INTELLIGENCE_LAST_ERROR_BYTES: usize = 2048;
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn wrong(expected: &str, value: Option<&Value>, path: Value) -> Value {
    let received = received(value);
    json!({"code":"invalid_type","expected":expected,"received":received,"path":path,"message":if received=="undefined"{"Required".to_owned()}else{format!("Expected {expected}, received {received}")}})
}
pub(super) fn validate(operation: &str, value: Option<&Value>) -> Result<Value> {
    if operation == "create" {
        let value =
            value.ok_or_else(|| validation_error(vec![wrong("object", None, json!([]))]))?;
        let request = parse_create(value)?;
        return serde_json::to_value(request)
            .map_err(|_| AgentCoreError::Http(500, "Internal server error".into(), None));
    }
    if !matches!(operation, "key-create" | "reset-session" | "permissions") {
        return Ok(Value::Null);
    }
    let fail = |issues: Vec<Value>| {
        AgentCoreError::Http(400, "Validation error".into(), Some(json!(issues)))
    };
    let Some(Value::Object(object)) = value else {
        return Err(fail(vec![wrong("object", value, json!([]))]));
    };
    if operation == "permissions" {
        let mut issues = Vec::new();
        let mut output = json!({});
        for key in ["canCreateAgents", "canManageSkills", "canAssignTasks"] {
            match object.get(key) {
                Some(Value::Bool(value)) => output[key] = json!(value),
                None if key == "canManageSkills" => (),
                value => issues.push(wrong("boolean", value, json!([key]))),
            }
        }
        return if issues.is_empty() {
            Ok(output)
        } else {
            Err(fail(issues))
        };
    }
    let (key, default, nullable) = if operation == "key-create" {
        ("name", Some(json!("default")), false)
    } else {
        ("taskKey", None, true)
    };
    let mut output = json!({});
    match object.get(key) {
        None => {
            if let Some(default) = default {
                output[key] = default
            }
        }
        Some(Value::Null) if nullable => output[key] = Value::Null,
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(fail(vec![
                    json!({"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"path":[key],"message":"String must contain at least 1 character(s)"}),
                ]));
            }
            output[key] = json!(s);
        }
        value => return Err(fail(vec![wrong("string", value, json!([key]))])),
    }
    Ok(output)
}

fn validation_error(issues: Vec<Value>) -> AgentCoreError {
    AgentCoreError::Http(400, "Validation error".into(), Some(json!(issues)))
}

fn intelligence_constraint(message: &str) -> AgentCoreError {
    AgentCoreError::Http(
        422,
        format!("Invalid nodeOwned.intelligenceDefaults: {message}"),
        None,
    )
}

fn unsupported_field(field: &str) -> AgentCoreError {
    AgentCoreError::Http(
        422,
        format!("Agent create field '{field}' is not owned by the Rust authority"),
        None,
    )
}

fn secret_like_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "apikey",
        "accesstoken",
        "authorization",
        "bearer",
        "secret",
        "passwd",
        "password",
        "credential",
        "jwt",
        "privatekey",
        "cookie",
        "connectionstring",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn node_owned_runtime_key(key: &str) -> bool {
    matches!(
        key,
        "rudderSkillSync"
            | "paperclipSkillSync"
            | "rudderRuntimeSkills"
            | "paperclipRuntimeSkills"
            | "instructionsFilePath"
            | "agentsMdPath"
            | "instructionsBundleMode"
            | "instructionsRootPath"
            | "instructionsEntryFile"
            | "promptTemplate"
            | "bootstrapPromptTemplate"
    )
}

fn env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn instruction_relative_path(value: &str) -> bool {
    let value = value.replace('\\', "/");
    value.len() <= MAX_INSTRUCTION_PATH_BYTES
        && !value.is_empty()
        && !value.starts_with('/')
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.contains(':')
                && !part.chars().any(char::is_control)
        })
}

fn normalized_env_binding(value: &Value, path: &str) -> Result<Value> {
    match value {
        Value::String(value) => Ok(json!({"type":"plain","value":value})),
        Value::Object(object) => {
            let kind = object.get("type").and_then(Value::as_str);
            match kind {
                Some("plain") => {
                    if object
                        .keys()
                        .any(|key| !matches!(key.as_str(), "type" | "value"))
                        || !object.get("value").is_some_and(Value::is_string)
                    {
                        return Err(unsupported_field(path));
                    }
                    Ok(json!({"type":"plain","value":object["value"]}))
                }
                Some("secret_ref") => {
                    if object
                        .keys()
                        .any(|key| !matches!(key.as_str(), "type" | "secretId" | "version"))
                        || !object
                            .get("secretId")
                            .is_some_and(|value| value.as_str().is_some_and(uuid_like))
                    {
                        return Err(unsupported_field(path));
                    }
                    let version = match object.get("version") {
                        None => json!("latest"),
                        Some(Value::String(value)) if value == "latest" => json!("latest"),
                        Some(Value::Number(value))
                            if value.as_u64().is_some_and(|value| value > 0) =>
                        {
                            Value::Number(value.clone())
                        }
                        _ => return Err(unsupported_field(path)),
                    };
                    Ok(json!({"type":"secret_ref","secretId":object["secretId"],"version":version}))
                }
                _ => Err(unsupported_field(path)),
            }
        }
        _ => Err(unsupported_field(path)),
    }
}

fn validate_env(value: &Value, path: &str) -> Result<Value> {
    let Some(object) = value.as_object() else {
        return Err(unsupported_field(path));
    };
    let mut output = serde_json::Map::new();
    for (key, value) in object {
        if !env_key(key) {
            return Err(unsupported_field(&format!("{path}.{key}")));
        }
        output.insert(
            key.clone(),
            normalized_env_binding(value, &format!("{path}.{key}"))?,
        );
    }
    Ok(Value::Object(output))
}

fn valid_runtime_type(value: &str) -> bool {
    matches!(
        value,
        "process"
            | "http"
            | "claude_local"
            | "codex_local"
            | "gemini_local"
            | "opencode_local"
            | "pi_local"
            | "cursor"
            | "openclaw_gateway"
            | "hermes_gateway"
            | "hermes_local"
    )
}

fn validate_model_fallbacks(value: &Value, path: &str) -> Result<()> {
    let Some(fallbacks) = value.as_array() else {
        return Err(unsupported_field(path));
    };
    for (index, fallback) in fallbacks.iter().enumerate() {
        let item_path = format!("{path}[{index}]");
        if let Some(model) = fallback.as_str() {
            if model.trim().is_empty() {
                return Err(unsupported_field(&item_path));
            }
            continue;
        }
        let Some(record) = fallback.as_object() else {
            return Err(unsupported_field(&item_path));
        };
        let runtime = record
            .get("agentRuntimeType")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .filter(|value| valid_runtime_type(value))
            .ok_or_else(|| unsupported_field(&format!("{item_path}.agentRuntimeType")))?;
        let _ = runtime;
        if record
            .get("model")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(unsupported_field(&format!("{item_path}.model")));
        }
        if let Some(config) = record.get("config") {
            if !config.is_object() {
                return Err(unsupported_field(&format!("{item_path}.config")));
            }
            reject_secret_like(config, &format!("{item_path}.config"))?;
            if let Some(env) = config.get("env") {
                validate_env(env, &format!("{item_path}.config.env"))?;
            }
        }
    }
    Ok(())
}

fn reject_secret_like(value: &Value, path: &str) -> Result<()> {
    if let Some(array) = value.as_array() {
        for (index, child) in array.iter().enumerate() {
            reject_secret_like(child, &format!("{path}[{index}]"))?;
        }
        return Ok(());
    }
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    for (key, child) in object {
        let child_path = if path.is_empty() {
            key.to_owned()
        } else {
            format!("{path}.{key}")
        };
        if secret_like_key(key) || node_owned_runtime_key(key) {
            return Err(unsupported_field(&child_path));
        }
        if key == "env" {
            validate_env(child, &child_path)?;
            continue;
        }
        if key == "modelFallbacks" {
            validate_model_fallbacks(child, &child_path)?;
            continue;
        }
        reject_secret_like(child, &child_path)?;
    }
    Ok(())
}

/// Parse and normalize the Rust-owned create subset. Defaults mirror
/// createAgentSchema; fields with side effects still owned by Node are
/// rejected instead of being silently discarded.
pub(super) fn parse_create(value: &Value) -> Result<AgentCreateRequest> {
    let Some(object) = value.as_object() else {
        return Err(validation_error(vec![wrong(
            "object",
            Some(value),
            json!([]),
        )]));
    };
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "name"
                | "role"
                | "title"
                | "capabilities"
                | "agentRuntimeType"
                | "agentRuntimeConfig"
                | "runtimeConfig"
                | "budgetMonthlyCents"
                | "permissions"
                | "metadata"
                | "desiredSkills"
                | "nodeOwned"
        ) {
            return Err(unsupported_field(key));
        }
    }
    let name = match object.get("name") {
        None => None,
        Some(Value::Null) => {
            return Err(validation_error(vec![wrong(
                "string",
                object.get("name"),
                json!(["name"]),
            )]));
        }
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_owned())
            }
        }
        value => {
            return Err(validation_error(vec![wrong(
                "string",
                value,
                json!(["name"]),
            )]));
        }
    };
    let role = string_or_default(object.get("role"), "general", "role")?;
    if ![
        "ceo",
        "cto",
        "cmo",
        "cfo",
        "engineer",
        "designer",
        "pm",
        "qa",
        "devops",
        "researcher",
        "general",
    ]
    .contains(&role.as_str())
    {
        return Err(validation_error(vec![json!({
            "code":"invalid_enum_value", "options":["ceo","cto","cmo","cfo","engineer","designer","pm","qa","devops","researcher","general"],
            "path":["role"], "message":"Invalid enum value"
        })]));
    }
    let title = optional_nullable_string(object.get("title"), "title")?;
    let capabilities = optional_nullable_string(object.get("capabilities"), "capabilities")?;
    let agent_runtime_type = string_or_default(
        object.get("agentRuntimeType"),
        "process",
        "agentRuntimeType",
    )?;
    if ![
        "process",
        "http",
        "claude_local",
        "codex_local",
        "gemini_local",
        "opencode_local",
        "pi_local",
        "cursor",
        "openclaw_gateway",
        "hermes_gateway",
        "hermes_local",
    ]
    .contains(&agent_runtime_type.as_str())
    {
        return Err(validation_error(vec![json!({
            "code":"invalid_enum_value", "path":["agentRuntimeType"],
            "message":"Invalid enum value"
        })]));
    }
    let agent_runtime_config = object
        .get("agentRuntimeConfig")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !agent_runtime_config.is_object() {
        return Err(validation_error(vec![wrong(
            "object",
            object.get("agentRuntimeConfig"),
            json!(["agentRuntimeConfig"]),
        )]));
    }
    reject_secret_like(&agent_runtime_config, "agentRuntimeConfig")?;
    let runtime_config = object
        .get("runtimeConfig")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !runtime_config.is_object() {
        return Err(validation_error(vec![wrong(
            "object",
            object.get("runtimeConfig"),
            json!(["runtimeConfig"]),
        )]));
    }
    reject_secret_like(&runtime_config, "runtimeConfig")?;
    let budget_monthly_cents = match object.get("budgetMonthlyCents") {
        None => 0,
        Some(Value::Number(value)) => {
            let Some(value) = value.as_f64() else {
                return Err(validation_error(vec![wrong(
                    "integer",
                    object.get("budgetMonthlyCents"),
                    json!(["budgetMonthlyCents"]),
                )]));
            };
            if !value.is_finite() || value.fract() != 0.0 {
                return Err(validation_error(vec![wrong(
                    "integer",
                    object.get("budgetMonthlyCents"),
                    json!(["budgetMonthlyCents"]),
                )]));
            }
            if value < 0.0 {
                return Err(validation_error(vec![json!({
                    "code":"too_small", "minimum":0, "type":"number", "inclusive":true,
                    "exact":false, "path":["budgetMonthlyCents"],
                    "message":"Number must be greater than or equal to 0"
                })]));
            }
            if value > i32::MAX as f64 {
                return Err(validation_error(vec![json!({
                    "code":"too_big", "maximum": i32::MAX, "type":"number", "inclusive":true,
                    "exact":false, "path":["budgetMonthlyCents"],
                    "message":"Number must be less than or equal to 2147483647"
                })]));
            }
            value as i64
        }
        value => {
            return Err(validation_error(vec![wrong(
                "number",
                value,
                json!(["budgetMonthlyCents"]),
            )]));
        }
    };
    let permissions = match object.get("permissions") {
        None => AgentCreatePermissions {
            can_create_agents: true,
            can_manage_skills: true,
        },
        Some(Value::Object(values)) => {
            if values
                .keys()
                .any(|key| !matches!(key.as_str(), "canCreateAgents" | "canManageSkills"))
            {
                return Err(unsupported_field(
                    values
                        .keys()
                        .find(|key| !matches!(key.as_str(), "canCreateAgents" | "canManageSkills"))
                        .expect("key"),
                ));
            }
            let can_create_agents = match values.get("canCreateAgents") {
                None => true,
                Some(Value::Bool(value)) => *value,
                value => {
                    return Err(validation_error(vec![wrong(
                        "boolean",
                        value,
                        json!(["permissions", "canCreateAgents"]),
                    )]));
                }
            };
            let can_manage_skills = match values.get("canManageSkills") {
                None => true,
                Some(Value::Bool(value)) => *value,
                value => {
                    return Err(validation_error(vec![wrong(
                        "boolean",
                        value,
                        json!(["permissions", "canManageSkills"]),
                    )]));
                }
            };
            AgentCreatePermissions {
                can_create_agents,
                can_manage_skills,
            }
        }
        value => {
            return Err(validation_error(vec![wrong(
                "object",
                value,
                json!(["permissions"]),
            )]));
        }
    };
    let metadata = match object.get("metadata") {
        None | Some(Value::Null) => None,
        Some(Value::Object(value)) => Some(Value::Object(value.clone())),
        value => {
            return Err(validation_error(vec![wrong(
                "object",
                value,
                json!(["metadata"]),
            )]));
        }
    };
    let desired_skills = match object.get("desiredSkills") {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .enumerate()
            .map(|(index, value)| match value {
                Value::String(value) if value.is_empty() => Err(validation_error(vec![json!({
                    "code":"too_small", "minimum":1, "type":"string", "inclusive":true,
                    "exact":false, "path":["desiredSkills", index],
                    "message":"String must contain at least 1 character(s)"
                })])),
                Value::String(value) => Ok(value.clone()),
                other => Err(validation_error(vec![wrong(
                    "string",
                    Some(other),
                    json!(["desiredSkills", index]),
                )])),
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .map(|value| js_trim(&value).to_owned())
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        value => {
            return Err(validation_error(vec![wrong(
                "array",
                value,
                json!(["desiredSkills"]),
            )]));
        }
    };
    let node_owned = match object.get("nodeOwned") {
        None => None,
        Some(Value::Object(node)) => {
            let config = node.get("normalizedAgentRuntimeConfig").ok_or_else(|| {
                validation_error(vec![wrong(
                    "object",
                    None,
                    json!(["nodeOwned", "normalizedAgentRuntimeConfig"]),
                )])
            })?;
            if !config.is_object() {
                return Err(validation_error(vec![wrong(
                    "object",
                    Some(config),
                    json!(["nodeOwned", "normalizedAgentRuntimeConfig"]),
                )]));
            }
            reject_secret_like(config, "nodeOwned.normalizedAgentRuntimeConfig")?;
            if node.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "normalizedAgentRuntimeConfig"
                        | "instructionsBundle"
                        | "avatarIcon"
                        | "intelligenceDefaults"
                )
            }) {
                return Err(unsupported_field("nodeOwned"));
            }
            let instructions_bundle = match node.get("instructionsBundle") {
                None | Some(Value::Null) => None,
                Some(Value::Object(bundle)) => {
                    if bundle.keys().any(|key| {
                        !matches!(
                            key.as_str(),
                            "entryFile" | "files" | "clearLegacyPromptTemplate"
                        )
                    }) {
                        return Err(unsupported_field("nodeOwned.instructionsBundle"));
                    }
                    let entry_file = match bundle.get("entryFile") {
                        Some(Value::String(value)) => {
                            let value = value.trim();
                            if !instruction_relative_path(value) {
                                return Err(unsupported_field(
                                    "nodeOwned.instructionsBundle.entryFile",
                                ));
                            }
                            value.replace('\\', "/")
                        }
                        value => {
                            return Err(validation_error(vec![wrong(
                                "string",
                                value,
                                json!(["nodeOwned", "instructionsBundle", "entryFile"]),
                            )]));
                        }
                    };
                    let files = match bundle.get("files") {
                        Some(Value::Object(files)) => {
                            if files.len() > MAX_INSTRUCTION_FILES {
                                return Err(unsupported_field(
                                    "nodeOwned.instructionsBundle.files",
                                ));
                            }
                            let mut output = BTreeMap::new();
                            let mut casefolded = BTreeSet::new();
                            casefolded.insert(entry_file.to_lowercase());
                            let mut total = entry_file.len();
                            for (path, value) in files {
                                if !instruction_relative_path(path) {
                                    return Err(unsupported_field(&format!(
                                        "nodeOwned.instructionsBundle.files.{path}"
                                    )));
                                }
                                let normalized = path.replace('\\', "/");
                                let folded = normalized.to_lowercase();
                                if !casefolded.insert(folded) && normalized != entry_file {
                                    return Err(unsupported_field(&format!(
                                        "nodeOwned.instructionsBundle.files.{path}"
                                    )));
                                }
                                let Some(body) = value.as_str() else {
                                    return Err(validation_error(vec![wrong(
                                        "string",
                                        Some(value),
                                        json!(["nodeOwned", "instructionsBundle", "files", path]),
                                    )]));
                                };
                                if body.len() > MAX_INSTRUCTION_FILE_BYTES {
                                    return Err(unsupported_field(&format!(
                                        "nodeOwned.instructionsBundle.files.{path}"
                                    )));
                                }
                                total = total
                                    .saturating_add(normalized.len())
                                    .saturating_add(body.len());
                                if total > MAX_INSTRUCTION_BUNDLE_BYTES {
                                    return Err(unsupported_field(
                                        "nodeOwned.instructionsBundle.files",
                                    ));
                                }
                                if output.insert(normalized, body.to_owned()).is_some() {
                                    return Err(unsupported_field(&format!(
                                        "nodeOwned.instructionsBundle.files.{path}"
                                    )));
                                }
                            }
                            output
                        }
                        value => {
                            return Err(validation_error(vec![wrong(
                                "object",
                                value,
                                json!(["nodeOwned", "instructionsBundle", "files"]),
                            )]));
                        }
                    };
                    let clear_legacy_prompt_template = match bundle.get("clearLegacyPromptTemplate")
                    {
                        None => false,
                        Some(Value::Bool(value)) => *value,
                        value => {
                            return Err(validation_error(vec![wrong(
                                "boolean",
                                value,
                                json!([
                                    "nodeOwned",
                                    "instructionsBundle",
                                    "clearLegacyPromptTemplate"
                                ]),
                            )]));
                        }
                    };
                    Some(AgentCreateInstructionsBundle {
                        entry_file,
                        files,
                        clear_legacy_prompt_template,
                    })
                }
                value => {
                    return Err(validation_error(vec![wrong(
                        "object",
                        value,
                        json!(["nodeOwned", "instructionsBundle"]),
                    )]));
                }
            };
            let avatar_icon = match node.get("avatarIcon") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => Some(value.trim().to_owned()),
                value => {
                    return Err(validation_error(vec![wrong(
                        "string",
                        value,
                        json!(["nodeOwned", "avatarIcon"]),
                    )]));
                }
            };
            let intelligence_defaults = match node.get("intelligenceDefaults") {
                None | Some(Value::Null) => None,
                Some(Value::Object(defaults)) => {
                    if defaults.keys().any(|key| {
                        !matches!(
                            key.as_str(),
                            "seed" | "status" | "lastError" | "lastVerifiedAt"
                        )
                    }) {
                        return Err(unsupported_field("nodeOwned.intelligenceDefaults"));
                    }
                    let seed = match defaults.get("seed") {
                        None => true,
                        Some(Value::Bool(value)) => *value,
                        value => {
                            return Err(validation_error(vec![wrong(
                                "boolean",
                                value,
                                json!(["nodeOwned", "intelligenceDefaults", "seed"]),
                            )]));
                        }
                    };
                    let status = match defaults.get("status") {
                        None => "disabled".to_owned(),
                        Some(Value::String(value))
                            if matches!(value.as_str(), "disabled" | "configured" | "invalid") =>
                        {
                            value.clone()
                        }
                        _value => {
                            return Err(validation_error(vec![json!({
                                "code":"invalid_enum_value",
                                "options":["disabled","configured","invalid"],
                                "path":["nodeOwned","intelligenceDefaults","status"],
                                "message":"Invalid enum value"
                            })]));
                        }
                    };
                    let last_error = match defaults.get("lastError") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(value))
                            if value.len() <= MAX_INTELLIGENCE_LAST_ERROR_BYTES =>
                        {
                            Some(value.clone())
                        }
                        Some(Value::String(_)) => {
                            return Err(intelligence_constraint(
                                "lastError must be at most 2048 bytes",
                            ));
                        }
                        value => {
                            return Err(validation_error(vec![wrong(
                                "string",
                                value,
                                json!(["nodeOwned", "intelligenceDefaults", "lastError"]),
                            )]));
                        }
                    };
                    let last_verified_at = match defaults.get("lastVerifiedAt") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(value))
                            if time::OffsetDateTime::parse(
                                value,
                                &time::format_description::well_known::Rfc3339,
                            )
                            .is_ok() =>
                        {
                            Some(value.clone())
                        }
                        Some(Value::String(_)) => {
                            return Err(intelligence_constraint(
                                "lastVerifiedAt must be an RFC3339 timestamp",
                            ));
                        }
                        value => {
                            return Err(validation_error(vec![wrong(
                                "string",
                                value,
                                json!(["nodeOwned", "intelligenceDefaults", "lastVerifiedAt"]),
                            )]));
                        }
                    };
                    match status.as_str() {
                        "disabled" if last_error.is_some() || last_verified_at.is_some() => {
                            return Err(intelligence_constraint(
                                "disabled status cannot include lastError or lastVerifiedAt",
                            ));
                        }
                        "configured" => {
                            if last_error.is_some() {
                                return Err(intelligence_constraint(
                                    "configured status cannot include lastError",
                                ));
                            }
                            if last_verified_at.is_none() {
                                return Err(intelligence_constraint(
                                    "configured status requires lastVerifiedAt",
                                ));
                            }
                        }
                        "invalid" => {
                            if last_error
                                .as_deref()
                                .is_none_or(|value| value.trim().is_empty())
                            {
                                return Err(intelligence_constraint(
                                    "invalid status requires a non-empty lastError",
                                ));
                            }
                            if last_verified_at.is_some() {
                                return Err(intelligence_constraint(
                                    "invalid status cannot include lastVerifiedAt",
                                ));
                            }
                        }
                        _ => {}
                    }
                    Some(AgentCreateIntelligenceDefaults {
                        seed,
                        status,
                        last_error,
                        last_verified_at,
                    })
                }
                value => {
                    return Err(validation_error(vec![wrong(
                        "object",
                        value,
                        json!(["nodeOwned", "intelligenceDefaults"]),
                    )]));
                }
            };
            Some(AgentCreateNodeOwned {
                normalized_agent_runtime_config: config.clone(),
                instructions_bundle,
                avatar_icon,
                intelligence_defaults,
            })
        }
        value => {
            return Err(validation_error(vec![wrong(
                "object",
                value,
                json!(["nodeOwned"]),
            )]));
        }
    };
    Ok(AgentCreateRequest {
        name,
        role,
        title,
        capabilities,
        agent_runtime_type,
        agent_runtime_config,
        runtime_config,
        budget_monthly_cents,
        permissions,
        metadata,
        desired_skills,
        node_owned,
    })
}

fn string_or_default(value: Option<&Value>, default: &str, key: &str) -> Result<String> {
    match value {
        None => Ok(default.to_owned()),
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        value => Err(validation_error(vec![wrong("string", value, json!([key]))])),
    }
}

fn optional_nullable_string(value: Option<&Value>, key: &str) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        value => Err(validation_error(vec![wrong("string", value, json!([key]))])),
    }
}

fn sensitive_env_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "apikey",
        "accesstoken",
        "auth",
        "authorization",
        "bearer",
        "secret",
        "passwd",
        "password",
        "credential",
        "jwt",
        "privatekey",
        "cookie",
        "connectionstring",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

async fn normalize_env(tx: &mut Tx<'_>, org: &str, value: &Value) -> Result<Value> {
    let validated = validate_env(value, "agentRuntimeConfig.env")?;
    let Some(object) = validated.as_object() else {
        return Err(unsupported_field("agentRuntimeConfig.env"));
    };
    let strict = env::var("RUDDER_SECRETS_STRICT_MODE")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"));
    let mut normalized = serde_json::Map::new();
    for (key, binding) in object {
        match binding.get("type").and_then(Value::as_str) {
            Some("plain") => {
                let value = binding["value"].as_str().unwrap_or_default();
                if strict && sensitive_env_key(key) && !value.trim().is_empty() {
                    return Err(AgentCoreError::Http(
                        422,
                        format!(
                            "Strict secret mode requires secret references for sensitive key: {key}"
                        ),
                        None,
                    ));
                }
                if value == "***REDACTED***" {
                    return Err(AgentCoreError::Http(
                        422,
                        format!("Refusing to persist redacted placeholder for key: {key}"),
                        None,
                    ));
                }
                normalized.insert(key.clone(), binding.clone());
            }
            Some("secret_ref") => {
                let secret_id = binding["secretId"].as_str().unwrap_or_default();
                let exists = sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM organization_secrets WHERE id=$1::uuid AND org_id=$2::uuid AND purpose='user_managed')",
                )
                .bind(secret_id)
                .bind(org)
                .fetch_one(&mut **tx)
                .await?;
                if !exists {
                    return Err(AgentCoreError::Http(
                        422,
                        format!("Secret must belong to same organization: {secret_id}"),
                        None,
                    ));
                }
                normalized.insert(key.clone(), binding.clone());
            }
            _ => return Err(unsupported_field(&format!("agentRuntimeConfig.env.{key}"))),
        }
    }
    Ok(Value::Object(normalized))
}

/// Apply the Node secrets service's persistence normalization while the Agent
/// create transaction is open. This deliberately resolves only references and
/// never decrypts or persists provider material.
pub(super) async fn normalize_runtime_config(
    tx: &mut Tx<'_>,
    org: &str,
    config: &Value,
) -> Result<Value> {
    let Some(object) = config.as_object() else {
        return Err(unsupported_field("agentRuntimeConfig"));
    };
    let mut normalized = object.clone();
    if let Some(env) = object.get("env") {
        normalized.insert("env".into(), normalize_env(tx, org, env).await?);
    }
    if let Some(fallbacks_value) = object.get("modelFallbacks") {
        validate_model_fallbacks(fallbacks_value, "agentRuntimeConfig.modelFallbacks")?;
        let fallbacks = fallbacks_value
            .as_array()
            .expect("validated modelFallbacks array");
        let mut next = Vec::with_capacity(fallbacks.len());
        for fallback in fallbacks {
            let Some(record) = fallback.as_object() else {
                // String model names are a valid Node fallback shorthand.
                next.push(fallback.clone());
                continue;
            };
            let Some(config) = record.get("config") else {
                next.push(fallback.clone());
                continue;
            };
            let mut next_record = record.clone();
            next_record.insert(
                "config".into(),
                Box::pin(normalize_runtime_config(tx, org, config)).await?,
            );
            next.push(Value::Object(next_record));
        }
        normalized.insert("modelFallbacks".into(), Value::Array(next));
    }
    Ok(Value::Object(normalized))
}

/// This is also a response boundary: malformed persisted settings produce the
/// same Zod error response as summarizeAgentIntegration, with unknown keys stripped.
pub(super) fn integration_settings(value: &Value) -> Result<Value> {
    let mut issues = Vec::new();
    let invalid =
        |issues| AgentCoreError::Http(400, "Validation error".into(), Some(json!(issues)));
    if value.is_null() {
        return Ok(json!({}));
    }
    let Some(object) = value.as_object() else {
        return Err(invalid(vec![wrong("object", Some(value), json!([]))]));
    };
    let Some(feishu) = object.get("feishu") else {
        return Ok(json!({}));
    };
    let Some(feishu) = feishu.as_object() else {
        return Err(invalid(vec![wrong(
            "object",
            Some(feishu),
            json!(["feishu"]),
        )]));
    };
    let mut output = json!({});
    for key in [
        "dailySessionRolloverEnabled",
        "dailySessionRolloverHours",
        "dailySessionRolloverNotifyFeishu",
    ] {
        let value = feishu.get(key);
        let path = json!(["feishu", key]);
        if key != "dailySessionRolloverHours" {
            match value {
                None => output[key] = json!(true),
                Some(Value::Bool(v)) => output[key] = json!(v),
                value => issues.push(wrong("boolean", value, path)),
            }
        } else {
            match value {
                None => output[key] = json!(24),
                Some(Value::Number(n)) => {
                    let n = n.as_f64().unwrap_or(f64::NAN);
                    if n.fract() != 0.0 {
                        issues.push(json!({"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":path}));
                    }
                    if n < 1.0 {
                        issues.push(json!({"code":"too_small","minimum":1,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 1","path":path}));
                    }
                    if n > 168.0 {
                        issues.push(json!({"code":"too_big","maximum":168,"type":"number","inclusive":true,"exact":false,"message":"Number must be less than or equal to 168","path":path}));
                    }
                    output[key] = value.cloned().unwrap_or(Value::Null);
                }
                value => issues.push(wrong("number", value, path)),
            }
        }
    }
    if issues.is_empty() {
        Ok(json!({"feishu":output}))
    } else {
        Err(invalid(issues))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_detail_permission_and_integration_zod() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/agent-detail-zod-boundary.json"
        ))
        .unwrap();
        for group in ["permissions", "integrations"] {
            for case in corpus[group].as_array().unwrap() {
                let result = if group == "permissions" {
                    validate("permissions", case.get("input"))
                } else {
                    integration_settings(&case["input"])
                };
                let actual = match result {
                    Ok(value) => json!({"status":200,"value":value}),
                    Err(AgentCoreError::Http(status, error, details)) => {
                        json!({"status":status,"error":error,"details":details})
                    }
                    Err(error) => panic!("{error}"),
                };
                assert_eq!(actual, case["expected"], "{group} case {}", case["index"]);
            }
        }
    }
    #[test]
    fn matches_fresh_shared_zod_corpus() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/agent-core-zod-boundary.json"
        ))
        .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let result = validate(case["operation"].as_str().unwrap(), case.get("input"));
            let actual = match result {
                Ok(value) => json!({"status":200,"value":value}),
                Err(AgentCoreError::Http(status, error, details)) => {
                    json!({"status":status,"error":error,"details":details})
                }
                Err(error) => panic!("Unexpected error: {error}"),
            };
            assert_eq!(
                actual, case["expected"],
                "{} case {}",
                case["operation"], case["index"]
            );
        }
    }

    #[test]
    fn create_defaults_are_typed_and_unsupported_side_effects_are_rejected() {
        let request = parse_create(&json!({"name":" Builder "})).expect("create defaults");
        assert_eq!(request.name.as_deref(), Some("Builder"));
        assert_eq!(request.role, "general");
        assert_eq!(request.agent_runtime_type, "process");
        assert_eq!(request.budget_monthly_cents, 0);
        assert!(request.permissions.can_create_agents);
        assert!(request.permissions.can_manage_skills);

        let decimal_integer: Value =
            serde_json::from_str(r#"{"budgetMonthlyCents":1.0}"#).expect("decimal integer JSON");
        assert_eq!(
            parse_create(&decimal_integer)
                .expect("decimal integer accepted")
                .budget_monthly_cents,
            1
        );
        let exponent_integer: Value =
            serde_json::from_str(r#"{"budgetMonthlyCents":1e3}"#).expect("exponent integer JSON");
        assert_eq!(
            parse_create(&exponent_integer)
                .expect("exponent integer accepted")
                .budget_monthly_cents,
            1_000
        );
        let fractional = parse_create(&json!({"budgetMonthlyCents": 1.5}))
            .expect_err("fractional budget rejected");
        assert!(matches!(fractional, AgentCoreError::Http(400, _, _)));

        for key in ["icon", "seedOrganizationIntelligenceDefaults"] {
            let mut input = serde_json::Map::new();
            input.insert(key.to_owned(), json!("unsupported"));
            let error = parse_create(&Value::Object(input)).expect_err("unsupported field");
            assert!(
                matches!(error, AgentCoreError::Http(422, _, _)),
                "{key}: {error:?}"
            );
        }
        let desired_skills_type_error =
            parse_create(&json!({"desiredSkills": "unsupported"})).expect_err("array field");
        assert!(matches!(
            desired_skills_type_error,
            AgentCoreError::Http(400, _, _)
        ));
        let error = parse_create(&json!({
            "agentRuntimeConfig": {"apiKey": "secret"}
        }))
        .expect_err("secret runtime config");
        assert!(matches!(error, AgentCoreError::Http(422, _, _)));
        let error = parse_create(&json!({
            "runtimeConfig": {"fallbacks": [{"privateKey": "secret"}]}
        }))
        .expect_err("nested secret runtime config");
        assert!(matches!(error, AgentCoreError::Http(422, _, _)));
        parse_create(&json!({
            "agentRuntimeType": "gemini_local",
        }))
        .expect("gemini runtime type remains accepted");
        parse_create(&json!({
            "agentRuntimeConfig": {
                "modelFallbacks": [
                    "gpt-4o-mini",
                    {"agentRuntimeType":"gemini_local","model":"gemini-2.5-pro","config":{"env":{"MODE":"backup"}}}
                ]
            }
        }))
        .expect("valid model fallback shorthand and runtime object");
        for malformed in [
            json!({"agentRuntimeConfig":{"modelFallbacks":[{"foo":1}]}}),
            json!({"agentRuntimeConfig":{"modelFallbacks":[{"agentRuntimeType":"bogus","model":"x"}]}}),
            json!({"agentRuntimeConfig":{"modelFallbacks":[{"agentRuntimeType":" codex_local ","model":"x"}]}}),
            json!({"agentRuntimeConfig":{"modelFallbacks":[{"agentRuntimeType":"codex_local"}]}}),
            json!({"agentRuntimeConfig":{"modelFallbacks":[""]}}),
            json!({"agentRuntimeConfig":{"modelFallbacks":[{"agentRuntimeType":"codex_local","model":"x","config":{"env":[]}}]}}),
            json!({"agentRuntimeConfig":{"modelFallbacks":[{"agentRuntimeType":"codex_local","model":"x","config":{"apiKey":"raw"}}]}}),
            json!({"agentRuntimeConfig":{"modelFallbacks":[{"agentRuntimeType":"codex_local","model":"x","config":{"privateKey":"raw"}}]}}),
        ] {
            assert!(matches!(
                parse_create(&malformed),
                Err(AgentCoreError::Http(422, _, _))
            ));
        }
        for key in [
            "rudderSkillSync",
            "paperclipSkillSync",
            "rudderRuntimeSkills",
            "paperclipRuntimeSkills",
            "instructionsFilePath",
            "agentsMdPath",
            "instructionsBundleMode",
            "instructionsRootPath",
            "instructionsEntryFile",
            "promptTemplate",
            "bootstrapPromptTemplate",
        ] {
            let mut runtime_config = serde_json::Map::new();
            runtime_config.insert(key.to_owned(), json!({"desiredSkills": []}));
            let input = json!({
                "runtimeConfig": {
                    "nested": [Value::Object(runtime_config)]
                }
            });
            let error = parse_create(&input).expect_err("Node-owned runtime config");
            assert!(
                matches!(error, AgentCoreError::Http(422, _, _)),
                "{key}: {error:?}"
            );
        }
    }

    #[test]
    fn create_accepts_only_typed_node_owned_preparation() {
        let request = parse_create(&json!({
            "agentRuntimeConfig": {
                "env": {
                    "MODEL": "fast",
                    "RUDDER_TOKEN": {"type":"secret_ref", "secretId":"10000000-0000-4000-8000-000000000099"}
                }
            },
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {
                    "env": {"MODEL": {"type":"plain", "value":"fast"}}
                },
                "instructionsBundle": {
                    "entryFile": "SOUL.md",
                    "files": {"SOUL.md": "# Prepared"},
                    "clearLegacyPromptTemplate": true
                }
            }
        }))
        .expect("typed preparation");
        assert!(request.node_owned.is_some());
        assert_eq!(request.agent_runtime_config["env"]["MODEL"], "fast");
        let bundle = request
            .node_owned
            .as_ref()
            .and_then(|value| value.instructions_bundle.as_ref())
            .expect("instruction bundle");
        assert_eq!(bundle.entry_file, "SOUL.md");
        assert_eq!(bundle.files["SOUL.md"], "# Prepared");

        for input in [
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{"apiKey":"raw"}}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"instructionsBundle":{"entryFile":"../SOUL.md","files":{}}}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"instructionsBundle":{"entryFile":"SOUL.md","files":{},"unexpected":"value"}}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"instructionsBundle":{"entryFile":"SOUL.md","files":{"a\\b":"one","a/b":"two"}}}}),
        ] {
            assert!(matches!(
                parse_create(&input),
                Err(AgentCoreError::Http(422, _, _))
            ));
        }

        let prepared = parse_create(&json!({
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {},
                "avatarIcon": "asset:40000000-0000-4000-8000-000000000001?bg=mist",
                "intelligenceDefaults": {
                    "status": "configured",
                    "lastError": null,
                    "lastVerifiedAt": "2026-10-18T01:02:03Z"
                }
            }
        }))
        .expect("typed identity preparation");
        let node = prepared.node_owned.expect("node-owned preparation");
        assert_eq!(
            node.avatar_icon.as_deref(),
            Some("asset:40000000-0000-4000-8000-000000000001?bg=mist")
        );
        assert_eq!(
            node.intelligence_defaults
                .as_ref()
                .map(|defaults| defaults.status.as_str()),
            Some("configured")
        );
        for input in [
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"avatarIcon":42}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"intelligenceDefaults":{"status":"enabled"}}}),
        ] {
            assert!(matches!(
                parse_create(&input),
                Err(AgentCoreError::Http(400, _, _))
            ));
        }
    }

    #[test]
    fn intelligence_defaults_enforce_status_error_and_timestamp_invariants() {
        let valid = parse_create(&json!({
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {},
                "intelligenceDefaults": {
                    "status": "configured",
                    "lastVerifiedAt": "2026-10-18T01:02:03Z"
                }
            }
        }))
        .expect("configured timestamp");
        assert_eq!(
            valid
                .node_owned
                .as_ref()
                .and_then(|node| node.intelligence_defaults.as_ref())
                .and_then(|defaults| defaults.last_verified_at.as_deref()),
            Some("2026-10-18T01:02:03Z")
        );

        for input in [
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"intelligenceDefaults":{"status":"configured","lastError":"probe failed"}}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"intelligenceDefaults":{"status":"invalid"}}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"intelligenceDefaults":{"status":"invalid","lastError":"probe failed","lastVerifiedAt":"2026-10-18T01:02:03Z"}}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"intelligenceDefaults":{"status":"disabled","lastVerifiedAt":"2026-10-18T01:02:03Z"}}}),
            json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"intelligenceDefaults":{"status":"configured","lastVerifiedAt":"not-a-timestamp"}}}),
        ] {
            assert!(matches!(
                parse_create(&input),
                Err(AgentCoreError::Http(422, _, _))
            ));
        }
        let oversized = "x".repeat(MAX_INTELLIGENCE_LAST_ERROR_BYTES + 1);
        assert!(matches!(
            parse_create(
                &json!({"nodeOwned":{"normalizedAgentRuntimeConfig":{},"intelligenceDefaults":{"status":"invalid","lastError":oversized}}})
            ),
            Err(AgentCoreError::Http(422, _, _))
        ));
    }
}
