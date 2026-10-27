//! Captured current Browser/Computer action contracts. The static shapes retain
//! the existing scalar/nested schema; named refinements below remain native.
use crate::desktop_broker::Kind;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

pub(crate) fn normalize(kind: Kind, action: &str, input: &Value) -> Result<Value, ()> {
    static SHAPES: OnceLock<Value> = OnceLock::new();
    let shapes = SHAPES.get_or_init(|| {
        serde_json::from_str(include_str!("desktop-capability-shapes.json"))
            .expect("captured desktop action shapes")
    });
    let group = match kind {
        Kind::Browser => "browser",
        Kind::Computer => "computer",
    };
    let schema = shapes[group].get(action).ok_or(())?;
    let value = shape(schema, Some(input))?.ok_or(())?;
    let has = |key: &str| value.get(key).is_some();
    match (kind, action) {
        (Kind::Browser, "open" | "navigate") => {
            let url = url::Url::parse(value["url"].as_str().ok_or(())?).map_err(|_| ())?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(());
            }
        }
        (Kind::Browser, "viewport")
            if value["action"] == "set" && (!has("width") || !has("height")) =>
        {
            return Err(());
        }
        (Kind::Browser, "cua") => {
            let operation = value["action"].as_str().ok_or(())?;
            if matches!(
                operation,
                "click" | "doubleClick" | "move" | "scroll" | "elementInfo"
            ) && (!has("x") || !has("y"))
            {
                return Err(());
            }
            if operation == "drag" && !has("path") {
                return Err(());
            }
            if operation == "keypress" && value["keys"].as_array().is_none_or(Vec::is_empty) {
                return Err(());
            }
            if operation == "type" && !has("text") {
                return Err(());
            }
        }
        (Kind::Browser, "clipboard") => {
            if value["action"] == "writeText" && !has("text") {
                return Err(());
            }
            if value["action"] == "write" && !has("items") {
                return Err(());
            }
            if let Some(items) = value["items"].as_array() {
                for item in items {
                    if let Some(entries) = item["entries"].as_array() {
                        for entry in entries {
                            if entry.get("text").is_some() == entry.get("base64").is_some() {
                                return Err(());
                            }
                        }
                    }
                }
            }
        }
        (Kind::Browser, "assets") if value["action"] == "bundle" => {
            if !has("inventoryId")
                || (value["assetIds"].as_array().is_none_or(Vec::is_empty)
                    && value["kinds"].as_array().is_none_or(Vec::is_empty))
            {
                return Err(());
            }
        }
        (Kind::Browser, "wait")
            if !has("url") && !has("text") && !has("textGone") && !has("timeMs") =>
        {
            return Err(());
        }
        (Kind::Browser, "screenshot")
            if (value["fullPage"] == true && (has("clip") || has("locator")))
                || (has("clip") && has("locator")) =>
        {
            return Err(());
        }
        (Kind::Computer, "launch_app") if !has("name") && !has("bundleId") => return Err(()),
        (Kind::Computer, "click")
            if !has("elementIndex") && !has("elementToken") && (!has("x") || !has("y")) =>
        {
            return Err(());
        }
        (Kind::Computer, "set_value" | "perform_secondary_action")
            if !has("elementIndex") && !has("elementToken") =>
        {
            return Err(());
        }
        _ => {}
    }
    Ok(value)
}
pub(crate) fn known_action(kind: Kind, action: &str) -> bool {
    let shapes: Value = serde_json::from_str(include_str!("desktop-capability-shapes.json"))
        .expect("captured desktop action shapes");
    shapes[match kind {
        Kind::Browser => "browser",
        Kind::Computer => "computer",
    }]
    .get(action)
    .is_some()
}
fn shape(schema: &Value, input: Option<&Value>) -> Result<Option<Value>, ()> {
    if schema["optional"] == true {
        return input
            .map(|input| shape(&schema["value"], Some(input)))
            .unwrap_or(Ok(None));
    }
    if schema["nullable"] == true {
        return if input == Some(&Value::Null) {
            Ok(Some(Value::Null))
        } else {
            shape(&schema["value"], input)
        };
    }
    if let Some(default) = schema.get("default") {
        return shape(&schema["value"], Some(input.unwrap_or(default)));
    }
    let input = input.ok_or(())?;
    if let Some(options) = schema["union"].as_array() {
        return options
            .iter()
            .find_map(|option| shape(option, Some(input)).ok())
            .ok_or(());
    }
    if let Some(options) = schema["enum"].as_array() {
        return options
            .contains(input)
            .then(|| Some(input.clone()))
            .ok_or(());
    }
    if let Some(literal) = schema.get("literal") {
        return (literal == input).then(|| Some(input.clone())).ok_or(());
    }
    let mut output = input.clone();
    match schema["type"].as_str().ok_or(())? {
        "boolean" => {
            if !input.is_boolean() {
                return Err(());
            }
        }
        "string" => {
            let mut text = input.as_str().ok_or(())?.to_owned();
            for check in schema["checks"].as_array().ok_or(())? {
                let length = text.encode_utf16().count() as u64;
                match check["kind"].as_str().ok_or(())? {
                    "trim" => {
                        text = text
                            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                            .to_owned()
                    }
                    "min" if length < check["value"].as_u64().ok_or(())? => return Err(()),
                    "max" if length > check["value"].as_u64().ok_or(())? => return Err(()),
                    "uuid" if text.len() != 36 || uuid::Uuid::parse_str(&text).is_err() => {
                        return Err(());
                    }
                    "min" | "max" | "uuid" => {}
                    _ => return Err(()),
                }
            }
            output = json!(text);
        }
        "number" => {
            let number = input.as_f64().ok_or(())?;
            if !number.is_finite() {
                return Err(());
            }
            for check in schema["checks"].as_array().ok_or(())? {
                match check["kind"].as_str().ok_or(())? {
                    "int" if number.fract() != 0.0 => return Err(()),
                    "min"
                        if if check["inclusive"] == false {
                            number <= check["value"].as_f64().ok_or(())?
                        } else {
                            number < check["value"].as_f64().ok_or(())?
                        } =>
                    {
                        return Err(());
                    }
                    "max"
                        if if check["inclusive"] == false {
                            number >= check["value"].as_f64().ok_or(())?
                        } else {
                            number > check["value"].as_f64().ok_or(())?
                        } =>
                    {
                        return Err(());
                    }
                    "int" | "min" | "max" | "finite" => {}
                    _ => return Err(()),
                }
            }
        }
        "array" => {
            let values = input.as_array().ok_or(())?;
            let len = values.len() as u64;
            if schema["min"].as_u64().is_some_and(|min| len < min)
                || schema["max"].as_u64().is_some_and(|max| len > max)
            {
                return Err(());
            }
            output = Value::Array(
                values
                    .iter()
                    .map(|value| shape(&schema["items"], Some(value))?.ok_or(()))
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        "object" => {
            let object = input.as_object().ok_or(())?;
            let properties = schema["properties"].as_object().ok_or(())?;
            if schema["strict"] == true && object.keys().any(|key| !properties.contains_key(key)) {
                return Err(());
            }
            let mut result = Map::new();
            for (key, schema) in properties {
                if let Some(value) = shape(schema, object.get(key))? {
                    result.insert(key.clone(), value);
                }
            }
            output = Value::Object(result);
        }
        _ => return Err(()),
    }
    Ok(Some(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_and_computer_match_current_node_action_contracts() {
        for (index, line) in include_str!("desktop-capability-validation-golden.jsonl")
            .lines()
            .enumerate()
        {
            let case: Value = serde_json::from_str(line).unwrap();
            let kind = if case["kind"] == "browser" {
                Kind::Browser
            } else {
                Kind::Computer
            };
            let result = normalize(kind, case["action"].as_str().unwrap(), &case["input"]);
            if case["invalid"] == true {
                assert!(result.is_err(), "case{index}: {case}");
            } else {
                assert_eq!(result.unwrap(), case["output"], "case{index}: {case}");
            }
        }
    }
}
