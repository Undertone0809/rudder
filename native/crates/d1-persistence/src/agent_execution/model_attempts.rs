//! Existing model fallback ordering and configuration projection. Config can
//! contain secret references or inline operator values: never Debug/Serialize.
use serde_json::{Map, Value, json};
use std::collections::HashSet;
pub struct ModelAttempt {
    pub index: i32,
    pub runtime_type: String,
    pub model: Option<String>,
    pub config: Value,
    pub fallback_index: Option<i32>,
    pub total_fallbacks: usize,
}
const SHARED: &[&str] = &[
    "promptTemplate",
    "bootstrapPromptTemplate",
    "instructionsFilePath",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsBundleMode",
    "agentsMdPath",
    "rudderSkillSync",
    "paperclipSkillSync",
    "rudderRuntimeSkills",
    "paperclipRuntimeSkills",
    "rudderBrowserEnabled",
];
fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn configuration(value: &Value) -> Map<String, Value> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "agentRuntimeType" | "model" | "modelFallbacks" | "config"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}
pub fn build(config: &Value, primary_runtime_type: &str) -> Vec<ModelAttempt> {
    let primary_model = text(config.get("model"));
    let mut seen = HashSet::new();
    if let Some(model) = primary_model.as_ref() {
        seen.insert((primary_runtime_type.to_owned(), model.clone()));
    }
    let mut fallbacks = Vec::new();
    for fallback in config
        .get("modelFallbacks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let runtime =
            text(fallback.get("agentRuntimeType")).unwrap_or_else(|| primary_runtime_type.into());
        let model = text(fallback.get("model")).or_else(|| text(Some(fallback)));
        let Some(model) = model else { continue };
        if !seen.insert((runtime.clone(), model.clone())) {
            continue;
        }
        let mut overrides = configuration(fallback);
        overrides.extend(configuration(&fallback["config"]));
        fallbacks.push((runtime, model, overrides));
    }
    let count = fallbacks.len();
    let mut attempts = vec![ModelAttempt {
        index: 0,
        runtime_type: primary_runtime_type.into(),
        model: primary_model,
        config: config.clone(),
        fallback_index: None,
        total_fallbacks: count,
    }];
    for (index, (runtime, model, overrides)) in fallbacks.into_iter().enumerate() {
        let mut fields = if runtime == primary_runtime_type {
            let mut base = config.as_object().cloned().unwrap_or_default();
            base.remove("modelFallbacks");
            base
        } else {
            SHARED
                .iter()
                .filter_map(|key| config.get(*key).map(|value| ((*key).into(), value.clone())))
                .collect()
        };
        fields.extend(overrides);
        fields.insert("model".into(), json!(model));
        attempts.push(ModelAttempt {
            index: i32::try_from(index + 1).unwrap_or(i32::MAX),
            runtime_type: runtime,
            model: Some(model),
            config: Value::Object(fields),
            fallback_index: Some(i32::try_from(index + 1).unwrap_or(i32::MAX)),
            total_fallbacks: count,
        });
    }
    attempts
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_matches_order_duplicates_nested_overrides_and_runtime_separation() {
        let config = json!({"model":"primary","command":"primary-command","promptTemplate":"trusted template","env":{"TOKEN":{"secretId":"ref"}},"modelFallbacks":["primary","backup",{"agentRuntimeType":"process","model":"other","command":"outer","config":{"command":"inner","model":"ignored","env":{"TOKEN":{"secretId":"other-ref"}}}},"backup",null]});
        let plan = build(&config, "codex_local");
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[1].config["command"], "primary-command");
        assert!(plan[1].config.get("modelFallbacks").is_none());
        assert_eq!(plan[1].config["env"]["TOKEN"]["secretId"], "ref");
        assert_eq!(plan[2].config["command"], "inner");
        assert_eq!(plan[2].config["model"], "other");
        assert_eq!(plan[2].config["promptTemplate"], "trusted template");
        assert_eq!(plan[2].fallback_index, Some(2));
        assert_eq!(plan[2].total_fallbacks, 2);
    }
}
