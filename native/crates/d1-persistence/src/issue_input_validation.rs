//! Nested public Issue input shapes shared with the TypeScript client schema.

use serde_json::{Map, Value};

pub(crate) fn validate_nested_fields(input: &Value) -> Result<(), &'static str> {
    for key in ["runWorkspaceSettings", "executionWorkspaceSettings"] {
        if let Some(value) = input.get(key)
            && !value.is_null()
            && !workspace_settings(value)
        {
            return Err("Invalid Issue run workspace settings");
        }
    }
    if let Some(value) = input.get("assigneeAgentRuntimeOverrides")
        && !value.is_null()
        && !runtime_overrides(value)
    {
        return Err("Invalid Issue assignee runtime overrides");
    }
    Ok(())
}

fn strict_object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    value
        .as_object()
        .filter(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}

fn workspace_settings(value: &Value) -> bool {
    let Some(object) = strict_object(value, &["mode", "workspaceStrategy", "workspaceRuntime"])
    else {
        return false;
    };
    object.get("mode").is_none_or(|value| {
        matches!(
            value.as_str(),
            Some("inherit" | "shared_workspace" | "isolated_workspace" | "operator_branch"
                | "reuse_existing" | "agent_default")
        )
    }) && object
        .get("workspaceRuntime")
        .is_none_or(|value| value.is_null() || value.is_object())
        && object
            .get("workspaceStrategy")
            .is_none_or(|value| value.is_null() || workspace_strategy(value))
}

fn workspace_strategy(value: &Value) -> bool {
    let Some(object) = strict_object(
        value,
        &["type", "baseRef", "branchTemplate", "worktreeParentDir", "provisionCommand", "teardownCommand"],
    ) else {
        return false;
    };
    object.get("type").is_none_or(|value| {
        matches!(value.as_str(), Some("project_primary" | "git_worktree" | "adapter_managed" | "cloud_sandbox"))
    }) && ["baseRef", "branchTemplate", "worktreeParentDir", "provisionCommand", "teardownCommand"]
        .iter()
        .all(|key| object.get(*key).is_none_or(|value| value.is_null() || value.is_string()))
}

fn runtime_overrides(value: &Value) -> bool {
    let Some(object) = strict_object(value, &["agentRuntimeConfig", "useProjectWorkspace"]) else {
        return false;
    };
    object.get("agentRuntimeConfig").is_none_or(Value::is_object)
        && object.get("useProjectWorkspace").is_none_or(Value::is_boolean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_shared_schema_shapes_and_nullable_top_level_fields() {
        for input in [json!({}), json!({"runWorkspaceSettings":null,"assigneeAgentRuntimeOverrides":null}),
            json!({"runWorkspaceSettings":{"mode":"isolated_workspace","workspaceStrategy":{"type":"git_worktree","baseRef":null,"provisionCommand":"prepare"},"workspaceRuntime":{"nested":[1,true,null]}},"assigneeAgentRuntimeOverrides":{"agentRuntimeConfig":{},"useProjectWorkspace":false}})] {
            assert!(validate_nested_fields(&input).is_ok(), "{input}");
        }
    }

    #[test]
    fn rejects_scalars_unknown_keys_and_invalid_nested_types_on_both_aliases() {
        for key in ["runWorkspaceSettings", "executionWorkspaceSettings"] {
            for value in [json!("invalid"),json!([]),json!({"unknown":true}),json!({"mode":null}),json!({"mode":"unexpected"}),json!({"workspaceRuntime":[]}),json!({"workspaceStrategy":{"type":null}}),json!({"workspaceStrategy":{"baseRef":1}}),json!({"workspaceStrategy":{"unknown":true}})] {
                assert!(validate_nested_fields(&json!({key:value})).is_err());
            }
        }
        for value in [json!(false),json!({"unknown":true}),json!({"agentRuntimeConfig":null}),json!({"useProjectWorkspace":"yes"})] {
            assert!(validate_nested_fields(&json!({"assigneeAgentRuntimeOverrides":value})).is_err());
        }
    }
}
