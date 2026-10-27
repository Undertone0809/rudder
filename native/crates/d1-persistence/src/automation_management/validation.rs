//! The existing public Zod shapes, including strip/partial/default/transform
//! behavior. SQL commands repeat this validation at the authority boundary.
use super::*;
use serde_json::Map;
fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn type_issue(errors: &mut Vec<Value>, path: Vec<Value>, expected: &str, v: Option<&Value>) {
    let got = received(v);
    errors.push(json!({"code":"invalid_type","expected":expected,"received":got,"path":path,"message":if v.is_none(){"Required".to_owned()}else{format!("Expected {expected}, received {got}")}}));
}
#[allow(clippy::too_many_arguments)]
fn string(
    errors: &mut Vec<Value>,
    out: &mut Map<String, Value>,
    body: &Map<String, Value>,
    key: &str,
    required: bool,
    nullable: bool,
    trim: bool,
    min: Option<usize>,
    max: Option<usize>,
) {
    let value = body.get(key);
    if value.is_none() && !required {
        return;
    }
    if nullable && value == Some(&Value::Null) {
        out.insert(key.into(), Value::Null);
        return;
    }
    let Some(raw) = value.and_then(Value::as_str) else {
        type_issue(errors, vec![json!(key)], "string", value);
        return;
    };
    let value = if trim { schedule::trim(raw) } else { raw };
    let length = value.encode_utf16().count();
    if let Some(min) = min.filter(|min| length < *min) {
        errors.push(json!({"code":"too_small","minimum":min,"type":"string","inclusive":true,"exact":false,"message":format!("String must contain at least {min} character(s)"),"path":[key]}));
    }
    if let Some(max) = max.filter(|max| length > *max) {
        errors.push(json!({"code":"too_big","maximum":max,"type":"string","inclusive":true,"exact":false,"message":format!("String must contain at most {max} character(s)"),"path":[key]}));
    }
    out.insert(key.into(), json!(value));
}
fn reference(
    errors: &mut Vec<Value>,
    out: &mut Map<String, Value>,
    body: &Map<String, Value>,
    key: &str,
    required: bool,
    nullable: bool,
) {
    string(
        errors, out, body, key, required, nullable, false, None, None,
    );
    if let Some(Value::String(v)) = out.get(key) {
        if v.len() != 36 || Uuid::parse_str(v).is_err() {
            errors.push(json!({"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":[key]}));
        }
    }
}
fn boolean(
    errors: &mut Vec<Value>,
    out: &mut Map<String, Value>,
    body: &Map<String, Value>,
    key: &str,
    default: Option<bool>,
) {
    match body.get(key) {
        Some(Value::Bool(v)) => {
            out.insert(key.into(), json!(v));
        }
        None => {
            if let Some(v) = default {
                out.insert(key.into(), json!(v));
            }
        }
        v => type_issue(errors, vec![json!(key)], "boolean", v),
    }
}
#[allow(clippy::too_many_arguments)]
fn enumeration(
    errors: &mut Vec<Value>,
    out: &mut Map<String, Value>,
    body: &Map<String, Value>,
    key: &str,
    options: &[&str],
    default: Option<&str>,
    nullable: bool,
) {
    let value = body.get(key);
    if value.is_none() {
        if let Some(default) = default {
            out.insert(key.into(), json!(default));
        }
        return;
    }
    if nullable && value == Some(&Value::Null) {
        out.insert(key.into(), Value::Null);
        return;
    }
    match value.and_then(Value::as_str){Some(v) if options.contains(&v)=>{out.insert(key.into(),json!(v));},Some(v)=>errors.push(json!({"received":v,"code":"invalid_enum_value","options":options,"path":[key],"message":format!("Invalid enum value. Expected {}, received '{v}'",options.iter().map(|v|format!("'{v}'")).collect::<Vec<_>>().join(" | "))})),_=>type_issue(errors,vec![json!(key)],&options.iter().map(|v|format!("'{v}'")).collect::<Vec<_>>().join(" | "),value)}
}
fn replay(
    errors: &mut Vec<Value>,
    out: &mut Map<String, Value>,
    body: &Map<String, Value>,
    default: bool,
    nullable: bool,
) {
    let value = body.get("replayWindowSec");
    match value {
        None => {
            if default {
                out.insert("replayWindowSec".into(), json!(300));
            }
        }
        Some(Value::Null) if nullable => {
            out.insert("replayWindowSec".into(), Value::Null);
        }
        Some(Value::Number(v)) => {
            let n = v.as_f64().unwrap_or(f64::NAN);
            if n.fract() != 0.0 {
                errors.push(json!({"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["replayWindowSec"]}));
            }
            for (bound, small) in [(30.0, true), (86400.0, false)] {
                if (small && n < bound) || (!small && n > bound) {
                    errors.push(json!({"code":if small{"too_small"}else{"too_big"},(if small{"minimum"}else{"maximum"}):bound as i64,"type":"number","inclusive":true,"exact":false,"message":format!("Number must be {} {}",if small{"greater than or equal to"}else{"less than or equal to"},bound as i64),"path":["replayWindowSec"]}));
                }
            }
            out.insert("replayWindowSec".into(), json!(v));
        }
        v => type_issue(errors, vec![json!("replayWindowSec")], "number", v),
    }
}
fn overrides(errors: &mut Vec<Value>, out: &mut Map<String, Value>, body: &Map<String, Value>) {
    let Some(value) = body.get("assigneeAgentRuntimeOverrides") else {
        return;
    };
    if value.is_null() {
        out.insert("assigneeAgentRuntimeOverrides".into(), Value::Null);
        return;
    }
    let Some(object) = value.as_object() else {
        type_issue(
            errors,
            vec![json!("assigneeAgentRuntimeOverrides")],
            "object",
            Some(value),
        );
        return;
    };
    for (key, expected) in [
        ("agentRuntimeConfig", "object"),
        ("useProjectWorkspace", "boolean"),
    ] {
        if let Some(value) = object.get(key) {
            if (expected == "object" && !value.is_object())
                || (expected == "boolean" && !value.is_boolean())
            {
                type_issue(
                    errors,
                    vec![json!("assigneeAgentRuntimeOverrides"), json!(key)],
                    expected,
                    Some(value),
                );
            }
        }
    }
    let unknown = object
        .keys()
        .filter(|k| !matches!(k.as_str(), "agentRuntimeConfig" | "useProjectWorkspace"))
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        errors.push(json!({"code":"unrecognized_keys","keys":unknown,"path":["assigneeAgentRuntimeOverrides"],"message":format!("Unrecognized key(s) in object: {}",unknown.iter().map(|key|format!("'{key}'")).collect::<Vec<_>>().join(", "))}));
    }
    out.insert("assigneeAgentRuntimeOverrides".into(), value.clone());
}
pub fn normalize_input(operation: Operation, input: Value) -> Result<Value> {
    if matches!(operation, Operation::Delete | Operation::TriggerDelete) {
        return Ok(json!({}));
    }
    let Some(body) = input.as_object() else {
        let mut errors = Vec::new();
        type_issue(&mut errors, vec![], "object", Some(&input));
        return Err(Error::Validation(json!(errors)));
    };
    let mut out = Map::new();
    let mut errors = Vec::new();
    match operation {
        Operation::Create | Operation::Update => {
            let create = operation == Operation::Create;
            reference(&mut errors, &mut out, body, "projectId", false, true);
            if create && !body.contains_key("projectId") {
                out.insert("projectId".into(), Value::Null);
            }
            for key in ["goalId", "parentIssueId"] {
                reference(&mut errors, &mut out, body, key, false, true);
            }
            string(
                &mut errors,
                &mut out,
                body,
                "title",
                create,
                false,
                true,
                Some(1),
                Some(200),
            );
            for key in ["instructions", "description"] {
                string(
                    &mut errors,
                    &mut out,
                    body,
                    key,
                    false,
                    true,
                    false,
                    None,
                    None,
                );
            }
            reference(
                &mut errors,
                &mut out,
                body,
                "assigneeAgentId",
                create,
                false,
            );
            overrides(&mut errors, &mut out, body);
            for (key, options, default) in [
                (
                    "priority",
                    &["critical", "high", "medium", "low"][..],
                    "medium",
                ),
                ("status", &["active", "paused"][..], "active"),
                (
                    "concurrencyPolicy",
                    &["coalesce_if_active", "always_enqueue", "skip_if_active"][..],
                    "coalesce_if_active",
                ),
                (
                    "catchUpPolicy",
                    &["skip_missed", "enqueue_missed_with_cap"][..],
                    "skip_missed",
                ),
                (
                    "outputMode",
                    &["track_issue", "chat_output"][..],
                    "track_issue",
                ),
            ] {
                enumeration(
                    &mut errors,
                    &mut out,
                    body,
                    key,
                    options,
                    create.then_some(default),
                    false,
                );
            }
            reference(
                &mut errors,
                &mut out,
                body,
                "chatConversationId",
                false,
                true,
            );
            if create && !body.contains_key("chatConversationId") {
                out.insert("chatConversationId".into(), Value::Null);
            }
            boolean(
                &mut errors,
                &mut out,
                body,
                "notifyOnIssueCreated",
                create.then_some(false),
            );
            if !errors.iter().any(|e| {
                matches!(
                    e["code"].as_str(),
                    Some("invalid_type" | "invalid_enum_value")
                )
            }) && out.get("chatConversationId").is_some_and(|v| !v.is_null())
            {
                errors.push(json!({"code":"custom","path":["chatConversationId"],"message":"Chat output creates an automation-owned conversation; existing chats cannot be selected"}));
            }
            if let Some(instructions) = out.remove("instructions") {
                out.insert("description".into(), instructions);
            }
            if out.get("outputMode") == Some(&json!("chat_output"))
                && out.get("notifyOnIssueCreated") == Some(&json!(true))
            {
                out.insert("notifyOnIssueCreated".into(), json!(false));
            }
        }
        Operation::TriggerCreate => {
            let options = ["schedule", "webhook", "api"];
            let Some(kind) = body
                .get("kind")
                .and_then(Value::as_str)
                .filter(|s| options.contains(s))
            else {
                return Err(Error::Validation(
                    json!([{"code":"invalid_union_discriminator","options":options,"path":["kind"],"message":"Invalid discriminator value. Expected 'schedule' | 'webhook' | 'api'"}]),
                ));
            };
            out.insert("kind".into(), json!(kind));
            string(
                &mut errors,
                &mut out,
                body,
                "label",
                false,
                true,
                true,
                None,
                Some(120),
            );
            boolean(&mut errors, &mut out, body, "enabled", Some(true));
            if kind == "schedule" {
                string(
                    &mut errors,
                    &mut out,
                    body,
                    "cronExpression",
                    true,
                    false,
                    true,
                    Some(1),
                    None,
                );
                string(
                    &mut errors,
                    &mut out,
                    body,
                    "timezone",
                    false,
                    false,
                    true,
                    Some(1),
                    None,
                );
                if !body.contains_key("timezone") {
                    out.insert("timezone".into(), json!("UTC"));
                }
            }
            if kind == "webhook" {
                enumeration(
                    &mut errors,
                    &mut out,
                    body,
                    "signingMode",
                    &["bearer", "hmac_sha256"],
                    Some("bearer"),
                    false,
                );
                replay(&mut errors, &mut out, body, true, false);
            }
        }
        Operation::TriggerUpdate => {
            string(
                &mut errors,
                &mut out,
                body,
                "label",
                false,
                true,
                true,
                None,
                Some(120),
            );
            boolean(&mut errors, &mut out, body, "enabled", None);
            for key in ["cronExpression", "timezone"] {
                string(
                    &mut errors,
                    &mut out,
                    body,
                    key,
                    false,
                    true,
                    true,
                    Some(1),
                    None,
                );
            }
            enumeration(
                &mut errors,
                &mut out,
                body,
                "signingMode",
                &["bearer", "hmac_sha256"],
                None,
                true,
            );
            replay(&mut errors, &mut out, body, false, true);
        }
        Operation::RotateSecret => (),
        Operation::Delete | Operation::TriggerDelete => unreachable!(),
    }
    if errors.is_empty() {
        Ok(Value::Object(out))
    } else {
        Err(Error::Validation(json!(errors)))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_partial_aliases_and_stripping_match_public_schema() {
        let a = Uuid::new_v4().to_string();
        let v=normalize_input(Operation::Create,json!({"title":"  example  ","assigneeAgentId":a,"instructions":"canonical","description":"legacy","ignored":true})).unwrap();
        assert_eq!(v["title"], "example");
        assert_eq!(v["description"], "canonical");
        assert_eq!(v["outputMode"], "track_issue");
        assert!(v.get("ignored").is_none());
        assert_eq!(
            normalize_input(Operation::Update, json!({})).unwrap(),
            json!({})
        );
        assert_eq!(
            normalize_input(Operation::RotateSecret, json!({"ignored":true})).unwrap(),
            json!({})
        );
    }
    #[test]
    fn validates_utf16_and_strict_runtime_overrides() {
        assert!(normalize_input(Operation::Update, json!({"title":"😀".repeat(101)})).is_err());
        assert!(
            normalize_input(
                Operation::Update,
                json!({"assigneeAgentRuntimeOverrides":{"unknown":true}})
            )
            .is_err()
        );
        assert!(normalize_input(Operation::TriggerUpdate, json!({"replayWindowSec":29})).is_err());
    }
}
