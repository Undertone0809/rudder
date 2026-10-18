//! Private Agent-create materialization for the organization intelligence
//! default. Runtime-chain probes stay in Node; this module only applies the
//! already prepared result inside the Agent transaction.

use super::{AgentCreateRequest, common::*};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const DEFAULT_CODEX_MODEL: &str = "gpt-6-luna";
const DEFAULT_CODEX_REASONING_EFFORT: &str = "medium";
const MAX_LAST_ERROR_BYTES: usize = 2048;

const AGENT_ONLY_CONFIG_KEYS: &[&str] = &[
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
];

fn sanitize_config(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return json!({});
    };
    let mut output = Map::new();
    for (key, child) in object {
        if AGENT_ONLY_CONFIG_KEYS.contains(&key.as_str()) {
            continue;
        }
        if key == "modelFallbacks"
            && let Some(fallbacks) = child.as_array()
        {
            output.insert(
                key.clone(),
                Value::Array(
                    fallbacks
                        .iter()
                        .map(|fallback| {
                            let Some(record) = fallback.as_object() else {
                                return fallback.clone();
                            };
                            let mut next = record.clone();
                            if let Some(config) = record.get("config") {
                                next.insert("config".to_owned(), sanitize_config(config));
                            }
                            Value::Object(next)
                        })
                        .collect(),
                ),
            );
            continue;
        }
        output.insert(key.clone(), child.clone());
    }
    Value::Object(output)
}

fn profile_config(agent_runtime_type: &str, source: &Value) -> Value {
    let mut config = match sanitize_config(source) {
        Value::Object(value) => value,
        _ => Map::new(),
    };
    if agent_runtime_type == "codex_local" {
        config.remove("reasoningEffort");
        config.insert("model".to_owned(), json!(DEFAULT_CODEX_MODEL));
        config.insert(
            "modelReasoningEffort".to_owned(),
            json!(DEFAULT_CODEX_REASONING_EFFORT),
        );
    } else if config
        .get("model")
        .and_then(Value::as_str)
        .is_none_or(|model| model.trim().is_empty())
    {
        config.remove("model");
    }
    Value::Object(config)
}

pub(super) fn feature_enabled() -> bool {
    std::env::var("RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
}

pub(super) fn requested(request: &AgentCreateRequest) -> bool {
    request
        .node_owned
        .as_ref()
        .is_some_and(|node| node.avatar_icon.is_some() || node.intelligence_defaults.is_some())
}

pub(super) async fn ensure_default(
    tx: &mut Tx<'_>,
    org: &str,
    agent_id: &str,
    request: &AgentCreateRequest,
    normalized_runtime_config: &Value,
) -> Result<()> {
    let Some(defaults) = request
        .node_owned
        .as_ref()
        .and_then(|node| node.intelligence_defaults.as_ref())
    else {
        return Ok(());
    };
    if !defaults.seed {
        return Ok(());
    }

    if defaults
        .last_error
        .as_deref()
        .is_some_and(|value| value.len() > MAX_LAST_ERROR_BYTES)
    {
        return Err(http(
            422,
            "Intelligence profile lastError exceeds 2048 bytes",
        ));
    }
    match defaults.status.as_str() {
        "disabled" if defaults.last_error.is_some() || defaults.last_verified_at.is_some() => {
            return Err(http(
                422,
                "Disabled intelligence profile cannot include lastError or lastVerifiedAt",
            ));
        }
        "configured" if defaults.last_error.is_some() || defaults.last_verified_at.is_none() => {
            return Err(http(
                422,
                "Configured intelligence profile requires lastVerifiedAt and cannot include lastError",
            ));
        }
        "invalid"
            if defaults
                .last_error
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
                || defaults.last_verified_at.is_some() =>
        {
            return Err(http(
                422,
                "Invalid intelligence profile requires lastError and cannot include lastVerifiedAt",
            ));
        }
        _ => {}
    }
    if request.agent_runtime_type != "codex_local"
        && (defaults.status != "disabled"
            || defaults.last_error.is_some()
            || defaults.last_verified_at.is_some())
    {
        return Err(http(
            422,
            "Non-codex intelligence profiles must be disabled without error",
        ));
    }
    if request.agent_runtime_type == "codex_local" && defaults.status == "disabled" {
        return Err(http(
            422,
            "Codex intelligence profiles must be configured or invalid",
        ));
    }
    if let Some(value) = defaults.last_verified_at.as_deref()
        && OffsetDateTime::parse(value, &Rfc3339).is_err()
    {
        return Err(http(
            422,
            "Intelligence profile lastVerifiedAt must be RFC3339",
        ));
    }

    // Agent creation holds the organization Agent-row lock. This query keeps
    // the Node first-agent semantics while preventing a cross-organization
    // profile write when the request body and actor disagree.
    let first_agent = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM agents WHERE org_id=$1::uuid ORDER BY created_at,id LIMIT 1",
    )
    .bind(org)
    .fetch_optional(&mut **tx)
    .await?;
    if first_agent.as_deref() != Some(agent_id) {
        return Ok(());
    }

    // Node's resolver treats both the canonical default and legacy lightweight
    // or reasoning profiles as an existing organization default. Preserve that
    // behavior before the Rust bridge attempts an insert; the resolver may
    // migrate legacy codex defaults in memory, but it never creates a second
    // profile row.
    let has_existing_default = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
           SELECT 1 FROM organization_intelligence_profiles
           WHERE org_id=$1::uuid AND purpose IN ('default','lightweight','reasoning')
         )",
    )
    .bind(org)
    .fetch_one(&mut **tx)
    .await?;
    if has_existing_default {
        return Ok(());
    }

    let query = "INSERT INTO organization_intelligence_profiles
          (org_id,purpose,agent_runtime_type,agent_runtime_config,status,last_error,last_verified_at)
         VALUES (
           $1::uuid,'default',$2,$3::jsonb,$4,$5,
           CASE WHEN $4='configured' THEN $6::timestamptz ELSE NULL END
         )
         ON CONFLICT(org_id,purpose) DO NOTHING";
    sqlx::query(query)
        .bind(org)
        .bind(&request.agent_runtime_type)
        .bind(profile_config(&request.agent_runtime_type, normalized_runtime_config).to_string())
        .bind(&defaults.status)
        .bind(defaults.last_error.as_deref())
        .bind(defaults.last_verified_at.as_deref())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_config_removes_agent_only_fields_and_applies_codex_defaults() {
        let value = profile_config(
            "codex_local",
            &json!({
                "model": "old",
                "reasoningEffort": "high",
                "promptTemplate": "private",
                "modelFallbacks": [{"model":"fallback","config":{"cwd":"private","keep":true}}]
            }),
        );
        assert_eq!(value["model"], DEFAULT_CODEX_MODEL);
        assert_eq!(
            value["modelReasoningEffort"],
            DEFAULT_CODEX_REASONING_EFFORT
        );
        assert!(value.get("reasoningEffort").is_none());
        assert!(value.get("promptTemplate").is_none());
        assert!(value["modelFallbacks"][0]["config"].get("cwd").is_none());
        assert_eq!(value["modelFallbacks"][0]["config"]["keep"], true);
    }
}
