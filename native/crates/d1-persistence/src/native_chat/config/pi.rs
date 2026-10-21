//! Strict, Rust-owned configuration for the local Pi RPC provider.
//!
//! This module resolves only identity-bearing, non-secret provider state. Pi
//! credentials remain in the operator/provider profile and are never copied
//! into a Rudder profile or persisted in the resolved carrier.

use super::resolve::{issue_workspace_binding, resolve_issue_workspace, validate_managed_cwd};
use super::{LocalHostContext, Result, fingerprint, invalid, unsupported};
use crate::agent_core::instructions;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

/// Trusted Pi paths and provider/model selection. The environment map exists
/// only for the in-process launch boundary; it is never serialized or logged.
pub struct PiLocalConfig {
    pub home: PathBuf,
    pub agent_dir: PathBuf,
    pub session_dir: PathBuf,
    pub profile_id: String,
    pub node_executable: PathBuf,
    pub pi_cli_entry: PathBuf,
    pub provider: String,
    pub model: String,
    pub thinking: Option<String>,
    pub timeout: Option<Duration>,
    pub cleanup_grace: Duration,
    pub env: BTreeMap<String, String>,
    pub profile_config_revision: String,
    pub env_revision: String,
}

/// Resolve the selected Pi Agent from the locked Conversation. This follows
/// the same organization, workspace, and instruction identity checks as the
/// Codex resolver while keeping Pi's profile/session paths provider-native.
pub(crate) async fn resolve_pi_config(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
) -> std::result::Result<super::ResolvedCodexConfig, super::Error> {
    let organization_id =
        super::super::validation::canonical_uuid(organization_id, "organization id")?;
    let conversation_id =
        super::super::validation::canonical_uuid(conversation_id, "conversation id")?;

    let (pi_node_executable, pi_cli_entry, pi_profiles_root) = host
        .pi_runtime()
        .ok_or_else(|| unsupported("the trusted local Pi installation is unavailable"))?;
    if !host.has_trusted_executable_search_path() {
        return Err(invalid(
            "selected native Pi profile requires trusted executable paths",
        ));
    }

    let row = sqlx::query(
        "/* native_chat_config_agent_lock */
         SELECT c.status AS conversation_status, c.conversation_kind,
                c.preferred_agent_id::text AS preferred_agent_id,
                c.routed_agent_id::text AS routed_agent_id,
                c.primary_issue_id::text AS primary_issue_id,
                c.model_override, c.effort_override, c.plan_mode,
                a.id::text AS agent_id, a.name AS agent_name, a.role AS agent_role,
                a.status AS agent_status, a.workspace_key,
                a.agent_runtime_type, a.agent_runtime_config::text AS agent_runtime_config
         FROM chat_conversations c
         JOIN agents a ON a.org_id=c.org_id
                      AND a.id=COALESCE(c.preferred_agent_id,c.routed_agent_id)
         WHERE c.org_id=$1::uuid AND c.id=$2::uuid
         FOR UPDATE OF c FOR SHARE OF a NOWAIT",
    )
    .bind(&organization_id)
    .bind(&conversation_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| match error {
        sqlx::Error::Database(ref database) if database.code().as_deref() == Some("55P03") => {
            super::http(409, "Native Chat Agent is being changed or removed")
        }
        other => other.into(),
    })?
    .ok_or_else(|| invalid("Chat or selected Agent is unavailable"))?;

    let conversation_kind: String = row.try_get("conversation_kind")?;
    let conversation_status: String = row.try_get("conversation_status")?;
    let selected_agent = row
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(row.try_get::<Option<String>, _>("routed_agent_id")?)
        .ok_or_else(|| invalid("Chat conversation has no selected Agent"))?;
    let agent_id: String = row.try_get("agent_id")?;
    let agent_status: String = row.try_get("agent_status")?;
    let runtime_type: String = row.try_get("agent_runtime_type")?;
    if conversation_kind != "chat"
        || conversation_status != "active"
        || selected_agent != agent_id
        || runtime_type != "pi_local"
        || matches!(agent_status.as_str(), "terminated" | "pending_approval")
    {
        return Err(invalid("selected Pi Agent is unavailable"));
    }

    let raw_config: String = row.try_get("agent_runtime_config")?;
    let config: Value = serde_json::from_str(&raw_config)
        .map_err(|_| invalid("Agent runtime configuration is malformed"))?;
    let object = config
        .as_object()
        .ok_or_else(|| invalid("Pi Agent runtime configuration must be an object"))?;
    const ALLOWED: &[&str] = &[
        "profileId",
        "cwd",
        "command",
        "model",
        "modelFallbacks",
        "thinking",
        "env",
        "instructionsBundleMode",
        "instructionsRootPath",
        "instructionsEntryFile",
        "instructionsFilePath",
        "skills",
        "enabledSkills",
        "mcpServers",
        "capabilities",
        "browser",
        "computer",
        "timeoutSec",
        "graceSec",
        "heartbeat",
        "promptTemplate",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(unsupported("an unrecognized Pi runtime setting is present"));
    }
    if let Some(command) = bounded_string(object.get("command"), "command")?
        && command != "pi"
        && Path::new(&command).canonicalize().ok().as_deref() != Some(pi_cli_entry)
    {
        return Err(unsupported(
            "configured Pi command does not match the trusted installation",
        ));
    }
    if object
        .get("modelFallbacks")
        .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
    {
        return Err(unsupported(
            "configured model fallbacks are not enabled for native Pi Chat",
        ));
    }
    if let Some(value) = object.get("promptTemplate")
        && value.as_str().is_some_and(|text| !text.trim().is_empty())
    {
        return Err(unsupported(
            "Pi prompt templates are not supported by native Chat yet",
        ));
    }
    if row.try_get::<bool, _>("plan_mode")? {
        return Err(unsupported("Pi has no verified Chat plan-mode mapping"));
    }
    let (timeout, cleanup_grace) = numeric_policy(object)?;
    validate_disabled_capabilities(object)?;

    let model_override: Option<String> = row.try_get("model_override")?;
    let configured_model = bounded_string(object.get("model"), "model")?;
    let model = model_override
        .filter(|value| !value.trim().is_empty())
        .or(configured_model)
        .ok_or_else(|| invalid("Pi requires an explicit provider/model selection"))?;
    let (provider, model_id) = split_provider_model(&model)?;

    let configured_thinking = bounded_string(object.get("thinking"), "thinking")?;
    let chat_thinking: Option<String> = row.try_get("effort_override")?;
    let thinking = chat_thinking
        .filter(|value| !value.trim().is_empty())
        .or(configured_thinking);
    if let Some(level) = thinking.as_deref() {
        validate_thinking(level)?;
    }

    let env = super::hermes::resolve_agent_env(tx, &organization_id, object.get("env")).await?;
    let env_facts: Vec<Value> = env
        .iter()
        .map(|(key, value)| json!({"name":key,"sha256":digest(value.as_bytes())}))
        .collect();

    let issue_ref: Option<String> = row.try_get("primary_issue_id")?;
    let (issue_project_id, issue_workspace_id) = if let Some(issue_id) = issue_ref.as_deref() {
        let issue = sqlx::query(
            "SELECT project_id::text AS project_id,
                    project_workspace_id::text AS project_workspace_id
             FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR SHARE",
        )
        .bind(&organization_id)
        .bind(issue_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| invalid("Chat primary issue is outside the organization"))?;
        (
            issue.try_get::<Option<String>, _>("project_id")?,
            issue.try_get::<Option<String>, _>("project_workspace_id")?,
        )
    } else {
        (None, None)
    };
    let workspace = resolve_issue_workspace(
        tx,
        &organization_id,
        issue_ref.as_deref(),
        issue_project_id.as_deref(),
        issue_workspace_id.as_deref(),
    )
    .await?;
    let agent_row = json!({
        "id": agent_id,
        "orgId": organization_id,
        "name": row.try_get::<String, _>("agent_name")?,
        "role": row.try_get::<String, _>("agent_role")?,
        "workspaceKey": row.try_get::<Option<String>, _>("workspace_key")?,
        "agentRuntimeConfig": config,
    });
    let fallback_cwd = instructions::managed_agent_workspace_path(
        host.instance_root(),
        host.workspace_home(),
        host.previous_documents_root(),
        host.friendly_workspace_home(),
        &organization_id,
        &agent_row,
    )
    .map_err(|_| invalid("managed Agent workspace is unavailable"))?;
    let cwd = if let Some(workspace) = workspace.as_ref() {
        workspace.cwd.clone()
    } else if let Some(configured) = object.get("cwd").and_then(Value::as_str) {
        super::resolve::canonical_cwd(Path::new(configured))?
    } else {
        validate_managed_cwd(&fallback_cwd, host.workspace_home())?
    };
    let instructions = instructions::resolve_readonly_for_runtime(
        host.instance_root(),
        host.workspace_home(),
        host.previous_documents_root(),
        host.friendly_workspace_home(),
        &organization_id,
        &agent_row,
        host.operator_home(),
        &cwd,
    )
    .map_err(|_| invalid("Agent instruction bundle cannot be resolved safely"))?;

    let profile_id = bounded_string(object.get("profileId"), "profileId")?
        .unwrap_or_else(|| "default".to_owned());
    validate_profile_id(&profile_id)?;
    let (profile_home, agent_dir, session_dir) = resolve_profile_paths(
        pi_profiles_root,
        host.operator_home(),
        &organization_id,
        &agent_id,
        &profile_id,
    )?;
    let profile_config_revision = pi_profile_revision(&agent_dir)?;
    let workspace_binding_id = issue_workspace_binding(&workspace);
    let mut revision = json!({
        "runtimeType":"pi_local", "profileId":profile_id,
        "provider":provider, "model":model_id, "thinking":thinking,
        "workspaceBindingId":workspace_binding_id,
        "effectiveCwd":cwd.to_string_lossy(), "env":env_facts,
        "timeoutSec":timeout.map(|value| value.as_secs_f64()),
        "graceSec":cleanup_grace.as_secs_f64(),
        "instructionsRevision":instructions.revision,
        "profileConfigRevision":profile_config_revision,
    });
    revision["executableSearchPathRevision"] = json!(fingerprint::digest(
        host.executable_search_path().as_bytes()
    ));
    let capability_revision = fingerprint::json_revision(&revision);
    let profile_kind = if profile_id == "operator-default" {
        "operator-pi"
    } else {
        "managed-pi"
    };
    let profile_ref = format!("{profile_kind}:{agent_id}:{profile_id}");
    let env_revision = fingerprint::json_revision(&json!(env_facts));

    let pi = PiLocalConfig {
        home: profile_home.clone(),
        agent_dir,
        session_dir,
        profile_id,
        node_executable: pi_node_executable.to_path_buf(),
        pi_cli_entry: pi_cli_entry.to_path_buf(),
        provider,
        model: model_id,
        thinking: thinking.clone(),
        timeout,
        cleanup_grace,
        env,
        profile_config_revision,
        env_revision,
    };
    Ok(super::ResolvedCodexConfig {
        identity: super::RuntimeBindingIdentity {
            agent_id,
            runtime_type,
            host_id: host.host_id().to_owned(),
            profile_id: profile_ref,
            workspace_binding_id,
            instructions_revision: instructions.revision,
            capability_revision,
        },
        // The common carrier keeps these fields for source compatibility. Pi
        // execution must use `pi`; its IDs never enter Codex request fields.
        executable: pi.node_executable.clone(),
        cwd,
        model: Some(model),
        reasoning_effort: thinking,
        plan_mode: false,
        search_enabled: false,
        bypass_approvals_and_sandbox: false,
        count_subscription_usage_as_cost: false,
        profile: super::ManagedCodexProfile {
            id: format!("{profile_kind}:{}", pi.profile_id),
            home: pi.home.clone(),
            native_managed: true,
        },
        operator_home: host.operator_home().to_path_buf(),
        executable_search_path: host.executable_search_path().to_owned(),
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
        hermes: None,
        pi: Some(pi),
        claude: None,
        cursor: None,
        opencode: None,
    })
}

fn numeric_policy(object: &serde_json::Map<String, Value>) -> Result<(Option<Duration>, Duration)> {
    let mut timeout = None;
    let mut grace = Duration::from_secs(20);
    if let Some(value) = object.get("timeoutSec") {
        let seconds = value
            .as_f64()
            .ok_or_else(|| invalid("Pi Chat timeout must be numeric"))?;
        if !(0.0..=3600.0).contains(&seconds) {
            return Err(invalid("Pi Chat timeout is invalid"));
        }
        if seconds > 0.0 {
            timeout = Some(Duration::from_secs_f64(seconds));
        }
    }
    if let Some(value) = object.get("graceSec") {
        let seconds = value
            .as_f64()
            .ok_or_else(|| invalid("Pi process grace period is invalid"))?;
        if !(0.0..=3600.0).contains(&seconds) {
            return Err(invalid("Pi process grace period is invalid"));
        }
        grace = Duration::from_secs_f64(seconds);
    }
    Ok((timeout, grace))
}

fn validate_disabled_capabilities(object: &serde_json::Map<String, Value>) -> Result<()> {
    for key in ["skills", "enabledSkills", "mcpServers", "capabilities"] {
        if object.get(key).is_some_and(|value| {
            !matches!(value, Value::Null) && value != &json!({}) && value != &json!([])
        }) {
            // Selected skills/MCP are materialized by the Rust host in later
            // execution stages. Until that boundary is wired, fail closed.
            return Err(unsupported(
                "configured optional Pi skills or MCP capabilities are not enabled",
            ));
        }
    }
    for key in ["browser", "computer"] {
        if object.get(key).is_some_and(|value| {
            !matches!(value, Value::Null | Value::Bool(false))
                && value != &json!({})
                && value != &json!([])
        }) {
            return Err(unsupported(
                "configured Pi browser or computer capability is not enabled",
            ));
        }
    }
    Ok(())
}

fn bounded_string(value: Option<&Value>, label: &str) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value))
            if value.len() <= 4096 && !value.chars().any(char::is_control) =>
        {
            Ok(Some(value.trim().to_owned()))
        }
        _ => Err(invalid(match label {
            "model" => "Pi model is invalid",
            "thinking" => "Pi thinking level is invalid",
            "profileId" => "Pi profileId is invalid",
            _ => "Pi runtime setting is invalid",
        })),
    }
}

fn split_provider_model(value: &str) -> Result<(String, String)> {
    let Some((provider, model)) = value.split_once('/') else {
        return Err(invalid("Pi model must use provider/model format"));
    };
    if provider.is_empty()
        || model.is_empty()
        || provider.len() > 256
        || model.len() > 4096
        || provider.chars().any(char::is_control)
        || model.chars().any(char::is_control)
    {
        return Err(invalid("Pi model must use provider/model format"));
    }
    Ok((provider.to_owned(), model.to_owned()))
}

fn validate_thinking(value: &str) -> Result<()> {
    if !["off", "minimal", "low", "medium", "high", "xhigh"].contains(&value) {
        return Err(invalid("Pi thinking level is invalid"));
    }
    Ok(())
}

fn validate_profile_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(invalid("Pi profileId is invalid"));
    }
    Ok(())
}

/// An explicit operator selection reuses provider configuration in place.
/// Session files stay under the instance-owned root, separate from credentials.
/// Resolution is read-only; startup provisions the owned session directory.
fn resolve_profile_paths(
    root: &Path,
    operator_home: &Path,
    organization_id: &str,
    agent_id: &str,
    profile_id: &str,
) -> Result<(PathBuf, PathBuf, PathBuf)> {
    if profile_id != "operator-default" {
        let home =
            super::resolve::managed_profile_home(root, organization_id, agent_id, profile_id)?;
        return Ok((
            home.clone(),
            home.join(".pi/agent"),
            home.join(".pi/paperclips"),
        ));
    }
    let home = checked_profile_directory(operator_home)?;
    let pi_dir = checked_profile_directory(&home.join(".pi"))?;
    let agent_dir = checked_profile_directory(&pi_dir.join("agent"))?;
    let session_dir = checked_profile_directory(&root.join("operator-sessions"))?;
    if !agent_dir.starts_with(&home) || !session_dir.starts_with(root) {
        return Err(invalid("selected Pi profile escaped its trusted root"));
    }
    Ok((home, agent_dir, session_dir))
}

fn checked_profile_directory(path: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| invalid("selected Pi profile directory is unavailable"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid("selected Pi profile directory is invalid"));
    }
    path.canonicalize()
        .map_err(|_| invalid("selected Pi profile directory is unavailable"))
}

/// Hash only non-secret Pi configuration files. `auth.json` is deliberately
/// excluded; provider credentials remain in the operator/provider profile.
fn pi_profile_revision(agent_dir: &Path) -> Result<String> {
    const MAX: u64 = 1024 * 1024;
    let mut facts = Vec::new();
    for name in ["settings.json", "models.json"] {
        let path = agent_dir.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(invalid("selected Pi profile configuration is unavailable")),
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX => {
                return Err(invalid("selected Pi profile configuration is invalid"));
            }
            Ok(meta) => {
                let bytes = fs::read(&path)
                    .map_err(|_| invalid("selected Pi profile configuration is unavailable"))?;
                if bytes.len() as u64 != meta.len() || bytes.len() as u64 > MAX {
                    return Err(invalid("selected Pi profile changed during resolution"));
                }
                facts.push(json!({"name":name,"sha256":digest(&bytes)}));
            }
        }
    }
    Ok(fingerprint::json_revision(&json!(facts)))
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        numeric_policy, resolve_profile_paths, split_provider_model, validate_profile_id,
        validate_thinking,
    };

    #[test]
    fn pi_requires_provider_model_identity() {
        assert_eq!(
            split_provider_model("deepseek/deepseek-chat").unwrap().0,
            "deepseek"
        );
        assert_eq!(
            split_provider_model("openrouter/deepseek/deepseek-chat")
                .unwrap()
                .1,
            "deepseek/deepseek-chat"
        );
        assert!(split_provider_model("deepseek").is_err());
        assert!(split_provider_model("/model").is_err());
    }

    #[test]
    fn pi_thinking_and_profile_values_are_bounded() {
        assert!(validate_thinking("xhigh").is_ok());
        assert!(validate_thinking("turbo").is_err());
        assert!(validate_profile_id("default").is_ok());
        assert!(validate_profile_id("../escape").is_err());
    }

    #[test]
    fn timing_policy_preserves_defaults_and_bounds_explicit_values() {
        let policy = |value: serde_json::Value| numeric_policy(value.as_object().unwrap());
        assert_eq!(
            policy(serde_json::json!({})).unwrap(),
            (None, std::time::Duration::from_secs(20))
        );
        assert_eq!(
            policy(serde_json::json!({"timeoutSec":0,"graceSec":20})).unwrap(),
            (None, std::time::Duration::from_secs(20))
        );
        assert_eq!(
            policy(serde_json::json!({"timeoutSec":1.25,"graceSec":2.5})).unwrap(),
            (
                Some(std::time::Duration::from_millis(1250)),
                std::time::Duration::from_millis(2500)
            )
        );
        for value in [
            serde_json::json!({"timeoutSec":-1}),
            serde_json::json!({"graceSec":3601}),
            serde_json::json!({"timeoutSec":"10"}),
            serde_json::json!({"graceSec":null}),
        ] {
            assert!(policy(value).is_err());
        }
    }

    #[test]
    fn operator_profile_reuses_config_and_keeps_sessions_under_the_owned_root() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let profiles = root.join("profiles");
        let operator = root.join("operator");
        std::fs::create_dir_all(operator.join(".pi/agent")).unwrap();
        std::fs::create_dir_all(profiles.join("operator-sessions")).unwrap();
        let paths = resolve_profile_paths(&profiles, &operator, "org", "agent", "operator-default")
            .unwrap();
        assert_eq!(
            paths,
            (
                operator.clone(),
                operator.join(".pi/agent"),
                profiles.join("operator-sessions")
            )
        );
        let managed =
            resolve_profile_paths(&profiles, &operator, "org", "agent", "default").unwrap();
        assert_eq!(managed.0, profiles.join("org/agent/default"));
        std::fs::remove_dir(profiles.join("operator-sessions")).unwrap();
        assert!(
            resolve_profile_paths(&profiles, &operator, "org", "agent", "operator-default")
                .is_err()
        );
        assert!(!profiles.join("operator-sessions").exists());
    }

    #[cfg(unix)]
    #[test]
    fn operator_profile_rejects_symlinked_configuration_or_session_directories() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let profiles = root.join("profiles");
        let operator = root.join("operator");
        let foreign = root.join("foreign");
        std::fs::create_dir_all(operator.join(".pi")).unwrap();
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::create_dir_all(profiles.join("operator-sessions")).unwrap();
        std::os::unix::fs::symlink(&foreign, operator.join(".pi/agent")).unwrap();
        assert!(
            resolve_profile_paths(&profiles, &operator, "org", "agent", "operator-default")
                .is_err()
        );
        std::fs::remove_file(operator.join(".pi/agent")).unwrap();
        std::fs::create_dir(operator.join(".pi/agent")).unwrap();
        std::fs::remove_dir(profiles.join("operator-sessions")).unwrap();
        std::os::unix::fs::symlink(&foreign, profiles.join("operator-sessions")).unwrap();
        assert!(
            resolve_profile_paths(&profiles, &operator, "org", "agent", "operator-default")
                .is_err()
        );
    }
}
