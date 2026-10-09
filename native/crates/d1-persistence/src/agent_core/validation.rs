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
    if !matches!(operation, "key-create" | "reset-session") {
        return Ok(Value::Null);
    }
    let fail = |issues: Vec<Value>| {
        AgentCoreError::Http(400, "Validation error".into(), Some(json!(issues)))
    };
    let Some(Value::Object(object)) = value else {
        return Err(fail(vec![wrong("object", value, json!([]))]));
    };
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

#[cfg(test)]
mod tests {
    use super::*;
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
