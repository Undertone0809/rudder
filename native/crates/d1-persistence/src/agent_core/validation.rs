//! Schemas for the independently migrated Agent endpoints. Absent root, null,
//! empty strings and unknown fields retain the exact public Zod distinction.
use super::{AgentCoreError, AgentCreatePermissions, AgentCreateRequest, common::Result};
use serde_json::{Value, json};
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
        if secret_like_key(key) || key == "env" {
            return Err(unsupported_field(&child_path));
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

        for key in [
            "icon",
            "desiredSkills",
            "seedOrganizationIntelligenceDefaults",
        ] {
            let error = parse_create(&json!({key:"unsupported"})).expect_err("unsupported field");
            assert!(
                matches!(error, AgentCoreError::Http(422, _, _)),
                "{key}: {error:?}"
            );
        }
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
    }
}
