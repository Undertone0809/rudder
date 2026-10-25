//! Schemas for the independently migrated Agent endpoints. Absent root, null,
//! empty strings and unknown fields retain the exact public Zod distinction.
use super::{
    AgentCoreError, AgentCreateInstructionsBundle, AgentCreateIntelligenceDefaults,
    AgentCreateNodeOwned, AgentCreatePermissions, AgentCreateRequest,
    common::{Result, Tx, js_trim, uuid_like},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
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
    if operation == "update" {
        return validate_update(value);
    }
    if matches!(
        operation,
        "instructions-path-get"
            | "instructions-bundle-get"
            | "instructions-file-get"
            | "instructions-file-delete"
    ) {
        return Ok(Value::Null);
    }
    if operation == "instructions-path-patch" {
        let Some(Value::Object(object)) = value else {
            return Err(AgentCoreError::Http(
                422,
                "Invalid instructions path".into(),
                None,
            ));
        };
        let mut output = serde_json::Map::new();
        match object.get("path") {
            Some(Value::Null) | Some(Value::String(_)) => {
                output.insert("path".into(), object["path"].clone())
            }
            _ => {
                return Err(AgentCoreError::Http(
                    422,
                    "Invalid instructions path".into(),
                    None,
                ));
            }
        };
        if let Some(key) = object.get("agentRuntimeConfigKey") {
            if !key.is_string() || key.as_str().is_some_and(|s| s.trim().is_empty()) {
                return Err(AgentCoreError::Http(
                    422,
                    "Invalid agentRuntimeConfigKey".into(),
                    None,
                ));
            }
            output.insert("agentRuntimeConfigKey".into(), key.clone());
        }
        return Ok(Value::Object(output));
    }
    if operation == "instructions-bundle-patch" {
        let Some(Value::Object(object)) = value else {
            return Err(AgentCoreError::Http(
                422,
                "Invalid instructions bundle".into(),
                None,
            ));
        };
        let mut output = serde_json::Map::new();
        if let Some(mode) = object.get("mode") {
            if !matches!(mode.as_str(), Some("managed" | "external")) {
                return Err(AgentCoreError::Http(
                    422,
                    "Invalid instructions bundle mode".into(),
                    None,
                ));
            }
            output.insert("mode".into(), mode.clone());
        }
        if let Some(root) = object.get("rootPath") {
            if !(root.is_null() || root.is_string()) {
                return Err(AgentCoreError::Http(
                    422,
                    "Invalid instructions bundle rootPath".into(),
                    None,
                ));
            }
            output.insert("rootPath".into(), root.clone());
        }
        if let Some(entry) = object.get("entryFile") {
            if !entry.is_string() || entry.as_str().is_some_and(|s| s.trim().is_empty()) {
                return Err(AgentCoreError::Http(
                    422,
                    "Invalid instructions bundle entryFile".into(),
                    None,
                ));
            }
            output.insert("entryFile".into(), entry.clone());
        }
        if let Some(clear) = object.get("clearLegacyPromptTemplate") {
            if !clear.is_boolean() {
                return Err(AgentCoreError::Http(
                    422,
                    "Invalid clearLegacyPromptTemplate".into(),
                    None,
                ));
            }
            output.insert("clearLegacyPromptTemplate".into(), clear.clone());
        }
        return Ok(Value::Object(output));
    }
    if operation == "instructions-file-put" {
        let Some(Value::Object(object)) = value else {
            return Err(AgentCoreError::Http(
                422,
                "Invalid instructions file".into(),
                None,
            ));
        };
        let path = object
            .get("path")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                AgentCoreError::Http(422, "Invalid instructions file path".into(), None)
            })?;
        let content = object
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AgentCoreError::Http(422, "Invalid instructions file content".into(), None)
            })?;
        if !instruction_relative_path(path) || content.len() > MAX_INSTRUCTION_FILE_BYTES {
            return Err(AgentCoreError::Http(
                422,
                "Invalid instructions file".into(),
                None,
            ));
        }
        let mut output = json!({"path": path, "content": content});
        if let Some(clear) = object.get("clearLegacyPromptTemplate") {
            if !clear.is_boolean() {
                return Err(AgentCoreError::Http(
                    422,
                    "Invalid clearLegacyPromptTemplate".into(),
                    None,
                ));
            }
            output["clearLegacyPromptTemplate"] = clear.clone();
        }
        return Ok(output);
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

/// Validate the public PATCH /api/agents/:id schema. This intentionally strips
/// unknown top-level keys like the shared Zod object, and keeps `replaceAgentRuntimeConfig`
/// as a route control rather than a persisted Agent field.
fn validate_update(value: Option<&Value>) -> Result<Value> {
    let Some(Value::Object(object)) = value else {
        return Err(validation_error(vec![wrong("object", value, json!([]))]));
    };

    let mut output = serde_json::Map::new();
    let mut issues = Vec::new();

    if let Some(value) = object.get("name") {
        match value {
            Value::String(name) => {
                let name = js_trim(name);
                if !name.is_empty() {
                    output.insert("name".into(), json!(name));
                }
            }
            value => issues.push(wrong("string", Some(value), json!(["name"]))),
        }
    }
    if let Some(value) = object.get("role") {
        if value.as_str().is_some_and(|role| {
            matches!(
                role,
                "ceo"
                    | "cto"
                    | "cmo"
                    | "cfo"
                    | "engineer"
                    | "designer"
                    | "pm"
                    | "qa"
                    | "devops"
                    | "researcher"
                    | "general"
            )
        }) {
            output.insert("role".into(), value.clone());
        } else {
            issues.push(json!({
                "code":"invalid_enum_value",
                "options":["ceo","cto","cmo","cfo","engineer","designer","pm","qa","devops","researcher","general"],
                "path":["role"],
                "message":"Invalid enum value"
            }));
        }
    }
    for key in ["title", "capabilities"] {
        if let Some(value) = object.get(key) {
            if value.is_null() || value.is_string() {
                output.insert(key.into(), value.clone());
            } else {
                issues.push(wrong("string", Some(value), json!([key])));
            }
        }
    }
    if let Some(value) = object.get("icon") {
        let normalized = match value {
            Value::Null => Some(Value::Null),
            Value::String(icon) if js_trim(icon).is_empty() => Some(Value::Null),
            Value::String(icon) if super::writes::supported_avatar_icon(js_trim(icon)) => {
                Some(json!(js_trim(icon)))
            }
            _ => None,
        };
        if let Some(icon) = normalized {
            output.insert("icon".into(), icon);
        } else {
            issues.push(json!({"code":"custom","path":["icon"],"message":"Invalid input"}));
        }
    }
    if let Some(value) = object.get("desiredSkills") {
        match value.as_array() {
            Some(skills) => {
                for (index, skill) in skills.iter().enumerate() {
                    match skill.as_str() {
                        Some(value) if !value.is_empty() => (),
                        Some(_) => issues.push(json!({
                            "code":"too_small","minimum":1,"type":"string","inclusive":true,
                            "exact":false,"path":["desiredSkills",index],
                            "message":"String must contain at least 1 character(s)"
                        })),
                        None => issues.push(wrong(
                            "string",
                            Some(skill),
                            json!(["desiredSkills", index]),
                        )),
                    }
                }
                output.insert("desiredSkills".into(), value.clone());
            }
            None => issues.push(wrong("array", Some(value), json!(["desiredSkills"]))),
        }
    }
    if let Some(value) = object.get("agentRuntimeType") {
        if value.as_str().is_some_and(public_runtime_type) {
            output.insert("agentRuntimeType".into(), value.clone());
        } else {
            issues.push(json!({
                "code":"invalid_enum_value",
                "options":["process","http","claude_local","codex_local","opencode_local","pi_local","cursor","openclaw_gateway","hermes_gateway","hermes_local"],
                "path":["agentRuntimeType"],
                "message":"Invalid enum value"
            }));
        }
    }
    if let Some(value) = object.get("agentRuntimeConfig") {
        if let Some(config) = value.as_object() {
            validate_public_adapter_config_schema(config, &mut issues);
            output.insert("agentRuntimeConfig".into(), value.clone());
        } else {
            issues.push(wrong("record", Some(value), json!(["agentRuntimeConfig"])));
        }
    }
    if let Some(value) = object.get("runtimeConfig") {
        if value.is_object() {
            output.insert("runtimeConfig".into(), value.clone());
        } else {
            issues.push(wrong("record", Some(value), json!(["runtimeConfig"])));
        }
    }
    if let Some(value) = object.get("budgetMonthlyCents") {
        if valid_nonnegative_integer(value) {
            output.insert("budgetMonthlyCents".into(), value.clone());
        } else {
            issues.push(number_issue(value, "budgetMonthlyCents"));
        }
    }
    if let Some(value) = object.get("permissions") {
        issues.push(wrong("never", Some(value), json!(["permissions"])));
    }
    if let Some(value) = object.get("metadata") {
        if value.is_null() || value.is_object() {
            output.insert("metadata".into(), value.clone());
        } else {
            issues.push(wrong("record", Some(value), json!(["metadata"])));
        }
    }
    if let Some(value) = object.get("replaceAgentRuntimeConfig") {
        if value.is_boolean() {
            output.insert("replaceAgentRuntimeConfig".into(), value.clone());
        } else {
            issues.push(wrong(
                "boolean",
                Some(value),
                json!(["replaceAgentRuntimeConfig"]),
            ));
        }
    }
    if let Some(value) = object.get("status") {
        if value.as_str().is_some_and(|status| {
            matches!(
                status,
                "active"
                    | "paused"
                    | "idle"
                    | "running"
                    | "error"
                    | "pending_approval"
                    | "terminated"
            )
        }) {
            output.insert("status".into(), value.clone());
        } else {
            issues.push(json!({
                "code":"invalid_enum_value",
                "options":["active","paused","idle","running","error","pending_approval","terminated"],
                "path":["status"],
                "message":"Invalid enum value"
            }));
        }
    }
    if let Some(value) = object.get("spentMonthlyCents") {
        if valid_nonnegative_integer(value) {
            output.insert("spentMonthlyCents".into(), value.clone());
        } else {
            issues.push(number_issue(value, "spentMonthlyCents"));
        }
    }

    if issues.is_empty() {
        Ok(Value::Object(output))
    } else {
        Err(validation_error(issues))
    }
}

fn valid_nonnegative_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number.fract() == 0.0 && number >= 0.0)
}

fn number_issue(value: &Value, key: &str) -> Value {
    if value.as_f64().is_none() {
        wrong("number", Some(value), json!([key]))
    } else if value.as_f64().is_some_and(|number| number.fract() != 0.0) {
        wrong("integer", Some(value), json!([key]))
    } else {
        json!({
            "code":"too_small","minimum":0,"type":"number","inclusive":true,
            "exact":false,"path":[key],
            "message":"Number must be greater than or equal to 0"
        })
    }
}

fn public_runtime_type(value: &str) -> bool {
    matches!(
        value,
        "process"
            | "http"
            | "claude_local"
            | "codex_local"
            | "opencode_local"
            | "pi_local"
            | "cursor"
            | "openclaw_gateway"
            | "hermes_gateway"
            | "hermes_local"
    )
}

fn valid_public_env(value: &Value) -> bool {
    value.as_object().is_some_and(|values| {
        values.values().all(|binding| match binding {
            Value::String(_) => true,
            Value::Object(binding) => match binding.get("type").and_then(Value::as_str) {
                Some("plain") => binding.get("value").is_some_and(Value::is_string),
                Some("secret_ref") => {
                    binding
                        .get("secretId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id == js_trim(id) && uuid_like(id))
                        && binding.get("version").is_none_or(|version| {
                            version.as_str() == Some("latest")
                                || version.as_f64().is_some_and(|number| {
                                    number.is_finite() && number.fract() == 0.0 && number > 0.0
                                })
                        })
                }
                _ => false,
            },
            _ => false,
        })
    })
}

fn validate_public_adapter_config_schema(
    config: &serde_json::Map<String, Value>,
    issues: &mut Vec<Value>,
) {
    if config.get("env").is_some_and(|env| !valid_public_env(env)) {
        issues.push(json!({
            "code":"custom","path":["agentRuntimeConfig","env"],
            "message":"agentRuntimeConfig.env must be a map of valid env bindings"
        }));
    }
    let Some(fallbacks) = config.get("modelFallbacks") else {
        return;
    };
    let Some(fallbacks) = fallbacks.as_array() else {
        issues.push(json!({"code":"custom","path":["agentRuntimeConfig","modelFallbacks"],"message":"modelFallbacks must be an array"}));
        return;
    };
    for (index, fallback) in fallbacks.iter().enumerate() {
        let path = json!(["agentRuntimeConfig", "modelFallbacks", index]);
        if let Some(model) = fallback.as_str() {
            if model.trim().is_empty() {
                issues.push(json!({"code":"custom","path":path,"message":"modelFallbacks string entries must be non-empty"}));
            }
            continue;
        }
        let Some(record) = fallback.as_object() else {
            issues.push(json!({"code":"custom","path":path,"message":"modelFallbacks entries must be strings or runtime/model objects"}));
            continue;
        };
        if record
            .get("agentRuntimeType")
            .and_then(Value::as_str)
            .is_none_or(|runtime| runtime.trim().is_empty())
        {
            issues.push(json!({"code":"custom","path":["agentRuntimeConfig","modelFallbacks",index,"agentRuntimeType"],"message":"modelFallbacks entries must include agentRuntimeType"}));
        } else if record
            .get("agentRuntimeType")
            .and_then(Value::as_str)
            .is_some_and(|runtime| !public_runtime_type(runtime))
        {
            issues.push(json!({"code":"custom","path":["agentRuntimeConfig","modelFallbacks",index,"agentRuntimeType"],"message":"modelFallbacks entries must include a valid agentRuntimeType"}));
        }
        if record
            .get("model")
            .and_then(Value::as_str)
            .is_none_or(|model| model.trim().is_empty())
        {
            issues.push(json!({"code":"custom","path":["agentRuntimeConfig","modelFallbacks",index,"model"],"message":"modelFallbacks entries must include model"}));
        }
        if let Some(nested) = record.get("config") {
            if let Some(nested) = nested.as_object() {
                if nested.get("env").is_some_and(|env| !valid_public_env(env)) {
                    issues.push(json!({"code":"custom","path":["agentRuntimeConfig","modelFallbacks",index,"config","env"],"message":"modelFallbacks entry config.env must be a map of valid env bindings"}));
                }
            } else {
                issues.push(json!({"code":"custom","path":["agentRuntimeConfig","modelFallbacks",index,"config"],"message":"modelFallbacks entry config must be an object"}));
            }
        }
    }
}

/// Validate the public Agent-create contract and translate it to the private
/// create command. Unknown request fields follow Zod's strip behavior; the
/// private `nodeOwned` preparation object is never accepted from a client.
pub(super) fn normalize_public_agent_create(input: Option<Value>) -> Result<Value> {
    let Some(Value::Object(source)) = input.as_ref() else {
        return Err(validation_error(vec![wrong(
            "object",
            input.as_ref(),
            json!([]),
        )]));
    };
    if source
        .get("seedOrganizationIntelligenceDefaults")
        .is_some_and(|value| value == true)
    {
        return Err(AgentCoreError::Http(
            503,
            "First-Agent intelligence runtime-chain preflight requires the compatibility handler"
                .into(),
            None,
        ));
    }
    if let Some(seed) = source.get("seedOrganizationIntelligenceDefaults")
        && !seed.is_boolean()
    {
        return Err(validation_error(vec![wrong(
            "boolean",
            Some(seed),
            json!(["seedOrganizationIntelligenceDefaults"]),
        )]));
    }

    let mut public = serde_json::Map::new();
    for key in [
        "name",
        "role",
        "title",
        "capabilities",
        "agentRuntimeType",
        "agentRuntimeConfig",
        "runtimeConfig",
        "budgetMonthlyCents",
        "permissions",
        "metadata",
        "desiredSkills",
    ] {
        if let Some(value) = source.get(key) {
            public.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(Value::Object(permissions)) = public.get_mut("permissions") {
        permissions.retain(|key, _| matches!(key.as_str(), "canCreateAgents" | "canManageSkills"));
    }

    let icon = match source.get("icon") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            let value = js_trim(value);
            if value.is_empty() {
                None
            } else if is_public_icon_name(value) || super::writes::supported_avatar_icon(value) {
                Some(value.to_owned())
            } else {
                return Err(validation_error(vec![json!({
                    "code":"custom",
                    "path":["icon"],
                    "message":"Invalid input"
                })]));
            }
        }
        value => {
            return Err(validation_error(vec![wrong(
                "string",
                value,
                json!(["icon"]),
            )]));
        }
    };

    let mut config = public
        .get("agentRuntimeConfig")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !config.is_object() {
        return Err(validation_error(vec![wrong(
            "object",
            public.get("agentRuntimeConfig"),
            json!(["agentRuntimeConfig"]),
        )]));
    }
    let runtime_type = public
        .get("agentRuntimeType")
        .and_then(Value::as_str)
        .unwrap_or("process");
    // Public API runtime types are the shared contract. Older Rust-private
    // records may still contain gemini_local, but it is not a public create
    // option in this version of @rudderhq/shared.
    if ![
        "process",
        "http",
        "claude_local",
        "codex_local",
        "opencode_local",
        "pi_local",
        "cursor",
        "openclaw_gateway",
        "hermes_gateway",
        "hermes_local",
    ]
    .contains(&runtime_type)
    {
        return Err(validation_error(vec![json!({
            "code":"invalid_enum_value",
            "options":["process","http","claude_local","codex_local","opencode_local","pi_local","cursor","openclaw_gateway","hermes_gateway","hermes_local"],
            "path":["agentRuntimeType"],
            "message":"Invalid enum value"
        })]));
    }

    let managed_instructions = matches!(runtime_type, "claude_local" | "codex_local" | "cursor");
    let prompt_template = config
        .as_object_mut()
        .and_then(|object| object.remove("promptTemplate"));
    if prompt_template.is_some() && !managed_instructions {
        return Err(AgentCoreError::Http(
            503,
            "Rust Agent create cannot prepare explicit instructions for this adapter".into(),
            None,
        ));
    }
    if contains_explicit_instruction_config(&config) {
        return Err(AgentCoreError::Http(
            503,
            "Rust Agent create cannot atomically prepare explicit instructions paths".into(),
            None,
        ));
    }
    strip_node_owned_runtime_keys(&mut config);
    public.insert("agentRuntimeConfig".to_owned(), config.clone());

    let mut node_owned = serde_json::Map::new();
    node_owned.insert("normalizedAgentRuntimeConfig".to_owned(), config);
    if let Some(icon) = icon {
        // The legacy helper accepts only uploaded, DiceBear, and Oreo values;
        // built-in icon names are valid schema input but resolve to a default.
        if super::writes::supported_avatar_icon(&icon) {
            node_owned.insert("avatarIcon".to_owned(), json!(icon));
        }
    }
    if managed_instructions {
        let prompt = prompt_template
            .as_ref()
            .and_then(Value::as_str)
            .unwrap_or_default();
        let files =
            super::instructions::default_create_bundle_files(role_for_bundle(&public["role"]));
        let mut files = files;
        if !js_trim(prompt).is_empty() {
            files.insert("SOUL.md".to_owned(), prompt.to_owned());
        }
        node_owned.insert(
            "instructionsBundle".to_owned(),
            json!({"entryFile":"SOUL.md","files":files,"clearLegacyPromptTemplate":true}),
        );
    }
    public.insert("nodeOwned".to_owned(), Value::Object(node_owned));
    let normalized = validate("create", Some(&Value::Object(public)))?;
    Ok(normalized)
}

fn role_for_bundle(value: &Value) -> &str {
    match value.as_str() {
        Some("ceo") => "ceo",
        _ => "default",
    }
}

fn is_public_icon_name(value: &str) -> bool {
    matches!(
        value,
        "bot"
            | "cpu"
            | "brain"
            | "zap"
            | "rocket"
            | "code"
            | "terminal"
            | "shield"
            | "eye"
            | "search"
            | "wrench"
            | "hammer"
            | "lightbulb"
            | "sparkles"
            | "star"
            | "heart"
            | "flame"
            | "bug"
            | "cog"
            | "database"
            | "globe"
            | "lock"
            | "mail"
            | "message-square"
            | "file-code"
            | "git-branch"
            | "package"
            | "puzzle"
            | "target"
            | "wand"
            | "atom"
            | "circuit-board"
            | "radar"
            | "swords"
            | "telescope"
            | "microscope"
            | "crown"
            | "gem"
            | "hexagon"
            | "pentagon"
            | "fingerprint"
    )
}

fn contains_explicit_instruction_config(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_explicit_instruction_config),
        Value::Object(values) => values.iter().any(|(key, child)| {
            matches!(
                key.as_str(),
                "promptTemplate"
                    | "bootstrapPromptTemplate"
                    | "instructionsRootPath"
                    | "instructionsFilePath"
                    | "agentsMdPath"
                    | "instructionsEntryFile"
                    | "instructionsBundleMode"
            ) || contains_explicit_instruction_config(child)
        }),
        _ => false,
    }
}

fn strip_node_owned_runtime_keys(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(strip_node_owned_runtime_keys),
        Value::Object(values) => {
            for key in [
                "promptTemplate",
                "bootstrapPromptTemplate",
                "instructionsFilePath",
                "instructionsRootPath",
                "instructionsEntryFile",
                "instructionsBundleMode",
                "agentsMdPath",
                "rudderBrowserEnabled",
                "rudderBrowserCapability",
                "rudderSkillSync",
                "paperclipSkillSync",
                "rudderRuntimeSkills",
                "paperclipRuntimeSkills",
                "workspaceStrategy",
                "workspaceRuntime",
                "cwd",
            ] {
                values.remove(key);
            }
            if let Some(fallbacks) = values.get_mut("modelFallbacks")
                && let Value::Array(fallbacks) = fallbacks
            {
                for fallback in fallbacks {
                    if let Some(config) = fallback.get_mut("config") {
                        strip_node_owned_runtime_keys(config);
                    }
                }
            }
        }
        _ => {}
    }
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

fn reject_secret_like_except_device_key(value: &Value, path: &str) -> Result<()> {
    if let Some(array) = value.as_array() {
        for (index, child) in array.iter().enumerate() {
            reject_secret_like_except_device_key(child, &format!("{path}[{index}]"))?;
        }
        return Ok(());
    }
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    for (key, child) in object {
        let child_path = format!("{path}.{key}");
        let device_key = path == "agentRuntimeConfig" && key == "devicePrivateKeyPem";
        if (secret_like_key(key) && !device_key) || node_owned_runtime_key(key) {
            return Err(unsupported_field(&child_path));
        }
        if key == "env" {
            validate_env(child, &child_path)?;
        } else if key == "modelFallbacks" {
            validate_model_fallbacks(child, &child_path)?;
        } else {
            reject_secret_like_except_device_key(child, &child_path)?;
        }
    }
    Ok(())
}

/// Apply the runtime defaults used by the public create route. The old private
/// bridge retains its compatibility bypass default; the public Rust path omits
/// that legacy Node default in the same way as the existing Rust cutover.
pub(super) fn apply_create_defaults(
    runtime_type: &str,
    config: &mut Value,
    public_agent_create: bool,
) -> Result<()> {
    let Some(object) = config.as_object_mut() else {
        return Err(unsupported_field("agentRuntimeConfig"));
    };
    if !public_agent_create {
        if runtime_type == "codex_local"
            && !(object
                .get("dangerouslyBypassApprovalsAndSandbox")
                .is_some_and(Value::is_boolean)
                || object
                    .get("dangerouslyBypassSandbox")
                    .is_some_and(Value::is_boolean))
        {
            let bypass =
                object.get("profileId").and_then(Value::as_str) != Some("operator-default");
            object.insert(
                "dangerouslyBypassApprovalsAndSandbox".to_owned(),
                json!(bypass),
            );
        }
        return Ok(());
    }
    match runtime_type {
        "codex_local" => {
            // Node's public create default is true unless either supported
            // bypass key is explicitly boolean. The UI sends false for its
            // operator-default profile, but API callers that omit the field
            // retain the established public create behavior.
            if !(object
                .get("dangerouslyBypassApprovalsAndSandbox")
                .is_some_and(Value::is_boolean)
                || object
                    .get("dangerouslyBypassSandbox")
                    .is_some_and(Value::is_boolean))
            {
                object.insert(
                    "dangerouslyBypassApprovalsAndSandbox".to_owned(),
                    json!(true),
                );
            }
            if object
                .get("model")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
            {
                object.insert("model".to_owned(), json!("gpt-5.6-luna"));
            }
            let has_reasoning_effort =
                ["modelReasoningEffort", "reasoningEffort"]
                    .iter()
                    .any(|key| {
                        object
                            .get(*key)
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.trim().is_empty())
                    });
            if !has_reasoning_effort {
                object.insert("modelReasoningEffort".to_owned(), json!("medium"));
            }
            if !object.get("search").is_some_and(Value::is_boolean) {
                object.insert("search".to_owned(), json!(true));
            }
        }
        "cursor" => {
            if object
                .get("model")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
            {
                object.insert("model".to_owned(), json!("auto"));
            }
        }
        "openclaw_gateway" => {
            let disable_device_auth =
                parse_boolean_like(object.get("disableDeviceAuth")) == Some(true);
            let has_device_key = object
                .get("devicePrivateKeyPem")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            if !disable_device_auth && !has_device_key {
                object.insert(
                    "devicePrivateKeyPem".to_owned(),
                    json!(generate_ed25519_private_key_pem()?),
                );
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_boolean_like(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::Number(value) if value.as_f64() == Some(1.0) => Some(true),
        Value::Number(value) if value.as_f64() == Some(0.0) => Some(false),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn generate_ed25519_private_key_pem() -> Result<String> {
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .map_err(|_| {
        AgentCoreError::Http(503, "Secure randomness is unavailable".into(), None)
    })?;
    let encoded = STANDARD.encode(pkcs8.as_ref());
    let wrapped = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).expect("base64 is ASCII"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "-----BEGIN PRIVATE KEY-----\n{wrapped}\n-----END PRIVATE KEY-----\n"
    ))
}

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
    if agent_runtime_type == "openclaw_gateway" {
        reject_secret_like_except_device_key(&agent_runtime_config, "agentRuntimeConfig")?;
    } else {
        reject_secret_like(&agent_runtime_config, "agentRuntimeConfig")?;
    }
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

/// Match the Node PATCH secret-normalization path. Unlike the create command,
/// PATCH accepts arbitrary runtime config keys and validates only the shared
/// public env/model-fallback schema before normalizing env bindings.
pub(super) async fn normalize_update_runtime_config(
    tx: &mut Tx<'_>,
    org: &str,
    config: &Value,
) -> Result<Value> {
    let Some(object) = config.as_object() else {
        return Err(AgentCoreError::Http(
            422,
            "agentRuntimeConfig must be an object".into(),
            None,
        ));
    };
    let mut normalized = object.clone();
    if let Some(env) = object.get("env") {
        normalized.insert("env".into(), normalize_update_env(tx, org, env).await?);
    }
    if let Some(Value::Array(fallbacks)) = object.get("modelFallbacks") {
        let mut normalized_fallbacks = Vec::with_capacity(fallbacks.len());
        for fallback in fallbacks {
            let Some(record) = fallback.as_object() else {
                normalized_fallbacks.push(fallback.clone());
                continue;
            };
            let Some(config) = record.get("config") else {
                normalized_fallbacks.push(fallback.clone());
                continue;
            };
            let mut normalized_record = record.clone();
            normalized_record.insert(
                "config".into(),
                Box::pin(normalize_update_runtime_config(tx, org, config)).await?,
            );
            normalized_fallbacks.push(Value::Object(normalized_record));
        }
        normalized.insert("modelFallbacks".into(), Value::Array(normalized_fallbacks));
    }
    Ok(Value::Object(normalized))
}

async fn normalize_update_env(tx: &mut Tx<'_>, org: &str, value: &Value) -> Result<Value> {
    let Some(bindings) = value.as_object() else {
        return Err(AgentCoreError::Http(
            422,
            "agentRuntimeConfig.env must be an object".into(),
            None,
        ));
    };
    let strict = env::var("RUDDER_SECRETS_STRICT_MODE")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"));
    let mut normalized = serde_json::Map::new();
    for (key, binding) in bindings {
        if !env_key(key) {
            return Err(AgentCoreError::Http(
                422,
                format!("Invalid environment variable name: {key}"),
                None,
            ));
        }
        let (kind, value, secret_id, version) = match binding {
            Value::String(value) => ("plain", Some(value.as_str()), None, None),
            Value::Object(binding)
                if binding.get("type").and_then(Value::as_str) == Some("plain") =>
            {
                let Some(value) = binding.get("value").and_then(Value::as_str) else {
                    return Err(AgentCoreError::Http(
                        422,
                        format!("Invalid environment binding for key: {key}"),
                        None,
                    ));
                };
                ("plain", Some(value), None, None)
            }
            Value::Object(binding)
                if binding.get("type").and_then(Value::as_str) == Some("secret_ref") =>
            {
                let Some(secret_id) = binding
                    .get("secretId")
                    .and_then(Value::as_str)
                    .filter(|value| uuid_like(value))
                else {
                    return Err(AgentCoreError::Http(
                        422,
                        format!("Invalid environment binding for key: {key}"),
                        None,
                    ));
                };
                let version = match binding.get("version") {
                    None => json!("latest"),
                    Some(Value::String(value)) if value == "latest" => json!("latest"),
                    Some(Value::Number(value))
                        if value
                            .as_f64()
                            .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n > 0.0) =>
                    {
                        value.clone().into()
                    }
                    _ => {
                        return Err(AgentCoreError::Http(
                            422,
                            format!("Invalid environment binding for key: {key}"),
                            None,
                        ));
                    }
                };
                ("secret_ref", None, Some(secret_id), Some(version))
            }
            _ => {
                return Err(AgentCoreError::Http(
                    422,
                    format!("Invalid environment binding for key: {key}"),
                    None,
                ));
            }
        };
        if kind == "plain" {
            let value = value.unwrap_or_default();
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
            normalized.insert(key.clone(), json!({"type":"plain","value":value}));
            continue;
        }
        let secret_id = secret_id.expect("secret reference has an id");
        let secret = sqlx::query_as::<_, (String, String)>(
            "SELECT org_id::text,purpose FROM organization_secrets WHERE id=$1::uuid",
        )
        .bind(secret_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some((secret_org, _purpose)) = secret.filter(|(_, purpose)| purpose == "user_managed")
        else {
            return Err(AgentCoreError::Http(404, "Secret not found".into(), None));
        };
        if secret_org != org {
            return Err(AgentCoreError::Http(
                422,
                "Secret must belong to same organization".into(),
                None,
            ));
        }
        normalized.insert(
            key.clone(),
            json!({"type":"secret_ref","secretId":secret_id,"version":version.expect("secret reference version")}),
        );
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
    fn codex_create_defaults_inherit_operator_policy_and_preserve_explicit_flags() {
        for (mut config, expected) in [
            (json!({"profileId":"operator-default"}), Some(false)),
            (json!({"profileId":"default"}), Some(true)),
            (json!({}), Some(true)),
            (
                json!({"profileId":"operator-default","dangerouslyBypassApprovalsAndSandbox":true}),
                Some(true),
            ),
            (
                json!({"profileId":"default","dangerouslyBypassApprovalsAndSandbox":false}),
                Some(false),
            ),
            (
                json!({"profileId":"operator-default","dangerouslyBypassSandbox":false}),
                None,
            ),
        ] {
            apply_create_defaults("codex_local", &mut config, false).unwrap();
            assert_eq!(
                config["dangerouslyBypassApprovalsAndSandbox"].as_bool(),
                expected
            );
        }
        let mut other_runtime = json!({"profileId":"operator-default"});
        apply_create_defaults("hermes_local", &mut other_runtime, false).unwrap();
        assert_eq!(other_runtime, json!({"profileId":"operator-default"}));
    }

    #[test]
    fn public_codex_create_matches_node_bypass_defaults_and_preserves_explicit_flags() {
        for (mut config, expected) in [
            (json!({"profileId":"operator-default"}), Some(true)),
            (json!({"profileId":"default"}), Some(true)),
            (json!({}), Some(true)),
            (
                json!({"profileId":"operator-default","dangerouslyBypassApprovalsAndSandbox":false}),
                Some(false),
            ),
            (
                json!({"profileId":"default","dangerouslyBypassApprovalsAndSandbox":true}),
                Some(true),
            ),
            (
                json!({"profileId":"operator-default","dangerouslyBypassSandbox":false}),
                None,
            ),
        ] {
            apply_create_defaults("codex_local", &mut config, true).unwrap();
            assert_eq!(
                config["dangerouslyBypassApprovalsAndSandbox"].as_bool(),
                expected
            );
        }

        let mut config = json!({"profileId":"operator-default"});
        apply_create_defaults("codex_local", &mut config, true).unwrap();
        assert_eq!(config["model"], "gpt-5.6-luna");
        assert_eq!(config["modelReasoningEffort"], "medium");
        assert_eq!(config["search"], true);

        let mut cursor = json!({});
        apply_create_defaults("cursor", &mut cursor, true).unwrap();
        assert_eq!(cursor["model"], "auto");
    }

    #[test]
    fn public_agent_create_normalizes_public_schema_and_strips_unknown_fields() {
        let normalized = normalize_public_agent_create(Some(json!({
            "name":"  Native Agent  ",
            "role":"engineer",
            "permissions":{"canCreateAgents":false,"unknown":true},
            "agentRuntimeConfig":{"command":"custom-agent"},
            "nodeOwned":{"avatarIcon":"forged"},
            "unknown":"stripped"
        })))
        .unwrap();
        let request = AgentCreateRequest::parse(&normalized).unwrap();
        assert_eq!(request.name.as_deref(), Some("Native Agent"));
        assert_eq!(request.role, "engineer");
        assert!(!request.permissions.can_create_agents);
        assert!(request.permissions.can_manage_skills);
        assert_eq!(
            request
                .node_owned
                .as_ref()
                .and_then(|node| node.avatar_icon.as_deref()),
            None
        );
        assert_eq!(request.agent_runtime_config["command"], "custom-agent");
    }

    #[test]
    fn public_agent_create_preflight_does_not_accept_intelligence_seed() {
        let error = normalize_public_agent_create(Some(json!({
            "name":"First Agent",
            "seedOrganizationIntelligenceDefaults":true
        })))
        .unwrap_err();
        assert!(matches!(error, AgentCoreError::Http(503, ..)));
    }

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
