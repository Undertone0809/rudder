//! Schemas for the independently migrated Agent endpoints. Absent root, null,
//! empty strings and unknown fields retain the exact public Zod distinction.
use super::{AgentCoreError, common::Result};
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
}
