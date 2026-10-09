use serde_json::{Value, json};
const MARKER: &str = "***REDACTED***";
fn secret(key: &str) -> bool {
    regex_lite::Regex::new(r"(?i)(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)").expect("secret regex").is_match(key)
}
fn reference(value: &Value) -> bool {
    value.is_object() && value["type"] == "secret_ref" && value["secretId"].is_string()
}
fn plain(value: &Value) -> bool {
    value.is_object() && value["type"] == "plain" && value.get("value").is_some()
}
fn jwt(value: &str) -> bool {
    let p = value.split('.').collect::<Vec<_>>();
    matches!(p.len(), 3 | 4)
        && p.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
}
fn sanitize_value(value: &Value) -> Value {
    if reference(value) {
        return value.clone();
    }
    if plain(value) {
        return json!({"type":"plain","value":sanitize_value(&value["value"])});
    }
    match value {
        Value::Array(a) => Value::Array(a.iter().map(sanitize_value).collect()),
        Value::Object(_) => sanitize(value),
        _ => value.clone(),
    }
}
pub(super) fn sanitize(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    Value::Object(
        object
            .iter()
            .map(|(key, value)| {
                let value = if secret(key) {
                    if reference(value) {
                        value.clone()
                    } else if plain(value) {
                        json!({"type":"plain","value":MARKER})
                    } else {
                        json!(MARKER)
                    }
                } else if value.as_str().is_some_and(jwt) {
                    json!(MARKER)
                } else {
                    sanitize_value(value)
                };
                (key.clone(), value)
            })
            .collect(),
    )
}
pub(super) fn omit(value: &Value) -> Value {
    if reference(value) {
        return value.clone();
    }
    match value {
        Value::Array(a) => Value::Array(a.iter().map(omit).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, v)| !secret(k) || reference(v))
                .map(|(k, v)| (k.clone(), omit(v)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
pub(super) fn config(value: &Value) -> Value {
    omit(&sanitize(value))
}
pub(super) fn contains_marker(value: &Value) -> bool {
    match value {
        Value::String(s) => s == MARKER,
        Value::Array(a) => a.iter().any(contains_marker),
        Value::Object(o) => o.values().any(contains_marker),
        _ => false,
    }
}
