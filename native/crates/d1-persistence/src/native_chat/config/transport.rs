//! Persisted settings for the four existing non-CLI Chat transports. The same
//! scoped workspace/instruction/secret readers serve local and remote owners.
use super::{LocalHostContext, Result, fingerprint, invalid, resolve};
use crate::agent_core::instructions;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

/// Contains resolved credentials for one invocation; never serialize or Debug.
pub struct TransportConfig {
    pub config: Value,
    pub env: BTreeMap<String, String>,
    pub secret_values: Vec<String>,
}

pub(crate) async fn resolve_transport_config(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    conversation: &str,
    host: &LocalHostContext,
) -> Result<super::ResolvedCodexConfig> {
    let row = sqlx::query(
        "/* native_chat_config_agent_lock */
        SELECT c.status AS conversation_status,c.conversation_kind,c.preferred_agent_id::text,
          c.routed_agent_id::text,c.primary_issue_id::text,c.model_override,
          a.id::text AS agent_id,a.name AS agent_name,a.role AS agent_role,a.status AS agent_status,
          a.workspace_key,a.agent_runtime_type,a.agent_runtime_config
        FROM chat_conversations c JOIN agents a ON a.org_id=c.org_id
          AND a.id=COALESCE(c.preferred_agent_id,c.routed_agent_id)
        WHERE c.org_id=$1::uuid AND c.id=$2::uuid FOR UPDATE OF c FOR SHARE OF a NOWAIT",
    )
    .bind(org)
    .bind(conversation)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| match error {
        sqlx::Error::Database(ref database) if database.code().as_deref() == Some("55P03") => {
            super::http(409, "Native Chat Agent is being changed or removed")
        }
        other => other.into(),
    })?
    .ok_or_else(|| invalid("Chat or selected Agent is unavailable"))?;
    let agent_id: String = row.try_get("agent_id")?;
    let selected = row
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(row.try_get::<Option<String>, _>("routed_agent_id")?);
    let runtime = host.attempt_runtime(row.try_get("agent_runtime_type")?);
    if row.try_get::<String, _>("conversation_kind")? != "chat"
        || row.try_get::<String, _>("conversation_status")? != "active"
        || selected.as_deref() != Some(agent_id.as_str())
        || matches!(
            row.try_get::<String, _>("agent_status")?.as_str(),
            "terminated" | "pending_approval"
        )
        || matches!(
            runtime.as_str(),
            "codex_local"
                | "pi_local"
                | "hermes_local"
                | "claude_local"
                | "cursor"
                | "cursor_local"
                | "opencode_local"
        )
    {
        return Err(invalid("selected transport Agent is unavailable"));
    }
    let raw: Value = host.attempt_config(row.try_get("agent_runtime_config")?);
    if !raw.is_object() {
        return Err(invalid("Agent runtime configuration must be an object"));
    }
    let mut config = raw.clone();
    if let Some(model) = host
        .attempt_chat_override(row.try_get::<Option<String>, _>("model_override")?)
        .filter(|v| !v.trim().is_empty())
    {
        config["model"] = json!(model);
    }
    let issue: Option<String> = row.try_get("primary_issue_id")?;
    let (project, workspace_id) = if let Some(issue) = &issue {
        let row = sqlx::query("SELECT project_id::text,project_workspace_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR SHARE")
            .bind(org).bind(issue).fetch_optional(&mut **tx).await?.ok_or_else(|| invalid("Chat primary Issue is outside the organization"))?;
        (
            row.try_get::<Option<String>, _>("project_id")?,
            row.try_get::<Option<String>, _>("project_workspace_id")?,
        )
    } else {
        (None, None)
    };
    let workspace = resolve::resolve_issue_workspace(
        tx,
        org,
        issue.as_deref(),
        project.as_deref(),
        workspace_id.as_deref(),
    )
    .await?;
    let agent = json!({"id":agent_id,"orgId":org,"name":row.try_get::<String,_>("agent_name")?,"role":row.try_get::<String,_>("agent_role")?,"workspaceKey":row.try_get::<Option<String>,_>("workspace_key")?,"agentRuntimeConfig":raw});
    let fallback = instructions::managed_agent_workspace_path(
        host.instance_root(),
        host.workspace_home(),
        host.previous_documents_root(),
        host.friendly_workspace_home(),
        org,
        &agent,
    )
    .map_err(|_| invalid("managed Agent workspace is unavailable"))?;
    let cwd = if let Some(workspace) = &workspace {
        workspace.cwd.clone()
    } else if let Some(cwd) = config["cwd"].as_str().filter(|v| !v.trim().is_empty()) {
        resolve::canonical_cwd(Path::new(cwd))?
    } else {
        resolve::validate_managed_cwd(&fallback, host.workspace_home())?
    };
    let instructions = instructions::resolve_readonly_for_runtime(
        host.instance_root(),
        host.workspace_home(),
        host.previous_documents_root(),
        host.friendly_workspace_home(),
        org,
        &agent,
        host.operator_home(),
        &cwd,
    )
    .map_err(|_| invalid("Agent instruction bundle cannot be resolved safely"))?;
    // Hash the unresolved effective snapshot. Resolved secret bytes never enter
    // persisted identity, activity, or checkpoint JSON.
    let revision = fingerprint::json_revision(
        &json!({"runtime":runtime,"config":config,"cwd":cwd,"instructions":instructions.revision}),
    );
    let mut secret_keys = BTreeSet::new();
    crate::agent_run_context::resolve_nested_config(tx, org, &mut config, &mut secret_keys)
        .await
        .map_err(|_| invalid("Agent runtime environment is unavailable"))?;
    let mut env = host.environment().clone();
    env.entry("PATH".into())
        .or_insert_with(|| host.executable_search_path().into());
    env.entry("HOME".into())
        .or_insert_with(|| host.operator_home().to_string_lossy().into_owned());
    for (key, value) in config["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            env.insert(key.clone(), value.into());
        }
    }
    validate_transport_config(&runtime, &config)?;
    let profile_id = format!("transport:{runtime}:{agent_id}");
    Ok(super::ResolvedCodexConfig {
        identity: super::RuntimeBindingIdentity {
            agent_id,
            runtime_type: runtime,
            host_id: host.host_id().into(),
            profile_id: profile_id.clone(),
            workspace_binding_id: resolve::issue_workspace_binding(&workspace),
            instructions_revision: instructions.revision,
            capability_revision: revision,
        },
        executable: None,
        cwd,
        model: config["model"].as_str().map(str::to_owned),
        reasoning_effort: None,
        plan_mode: false,
        search_enabled: false,
        bypass_approvals_and_sandbox: false,
        count_subscription_usage_as_cost: false,
        profile: super::ManagedCodexProfile {
            id: profile_id,
            home: host.operator_home().to_path_buf(),
            native_managed: false,
        },
        operator_home: host.operator_home().to_path_buf(),
        executable_search_path: host.executable_search_path().into(),
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
        hermes: None,
        pi: None,
        claude: None,
        cursor: None,
        opencode: None,
        model_attempt: None,
        transport: Some(TransportConfig {
            secret_values: secret_keys
                .iter()
                .filter_map(|key| env.get(key))
                .filter(|value| !value.is_empty())
                .cloned()
                .collect(),
            config,
            env,
        }),
    })
}

fn validate_transport_config(runtime: &str, config: &Value) -> Result<()> {
    let process = !matches!(runtime, "http" | "hermes_gateway" | "openclaw_gateway");
    let key = if process { "command" } else { "url" };
    // Command presence is an attempt-execution error in the established
    // process adapter, and can select a configured model fallback. Keep type,
    // environment and secret validation here; the existing prelaunch resolver
    // checks a missing/empty command while it still owns the unused permit.
    if process && config.get(key).is_some_and(|value| !value.is_string()) {
        return Err(invalid("Process adapter command must be a string"));
    }
    if runtime == "http" {
        let url = config[key]
            .as_str()
            .ok_or_else(|| invalid("HTTP adapter missing url"))?;
        url::Url::parse(url).map_err(|_| invalid("HTTP adapter URL is invalid"))?;
    }
    // Gateway-specific legacy aliases/defaults are resolved by the same shared
    // client used for Heartbeat; admission does not invent a narrower schema.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_process_fallback_and_gateway_settings_keep_their_transport_contract() {
        for runtime in ["process", "custom_old_runtime"] {
            assert!(
                validate_transport_config(
                    runtime,
                    &json!({"command":"/bin/sh","args":["-c","true"]})
                )
                .is_ok()
            );
            assert!(validate_transport_config(runtime, &json!({})).is_ok());
            assert!(validate_transport_config(runtime, &json!({"command":""})).is_ok());
            assert!(validate_transport_config(runtime, &json!({"command":false})).is_err());
        }
        assert!(validate_transport_config("http", &json!({"url":"http://127.0.0.1:80"})).is_ok());
        assert!(validate_transport_config("http", &json!({"url":"invalid url"})).is_err());
        for runtime in ["hermes_gateway", "openclaw_gateway"] {
            assert!(validate_transport_config(runtime,&json!({"url":"http://127.0.0.1","headers":{"x-fixture":"value"},"sessionKeyStrategy":"run"})).is_ok());
        }
    }
}
