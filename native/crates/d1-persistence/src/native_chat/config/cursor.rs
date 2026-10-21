//! Cursor Agent ACP configuration resolved from locked Chat state.
//!
//! This module owns only trusted installation/profile selection.  ACP process
//! I/O lives in `rudder-cursor-acp-adapter`; D1 admission and provider
//! identity checkpoints remain separate Rust authorities.

use super::resolve::{issue_workspace_binding, resolve_issue_workspace, validate_managed_cwd};
use super::{LocalHostContext, Result, fingerprint, invalid, runtime, unsupported};
use crate::agent_core::instructions;
use crate::native_chat::config::resolve_agent_env;
use rudder_cursor_acp_adapter::MAX_TEXT_BYTES;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

/// Trusted Cursor ACP installation facts.  The home path is selected by the
/// Rust host and never accepted from an HTTP request or Agent JSON.
pub struct CursorLocalConfig {
    pub home: PathBuf,
    pub profile_id: String,
    pub executable_search_path: String,
    pub model: Option<String>,
    /// CLI-ready Cursor model selector derived from the locked model and
    /// effort values. `None` means inherit the selected operator profile.
    pub cli_model: Option<String>,
    pub mode: Option<String>,
    pub env: BTreeMap<String, String>,
    pub profile_config_revision: String,
    pub env_revision: String,
    pub timeout_sec: Option<u64>,
    pub grace_sec: Option<u64>,
    /// True only when this run uses the canonical managed Agent fallback
    /// workspace without issue/project binding or an Agent-supplied cwd.
    /// Cursor rules are materialized there, never in external/user workspaces.
    pub managed_instruction_workspace: bool,
    pub instruction_agent_id: String,
    pub instruction_revision: String,
}

pub(crate) async fn resolve_cursor_config(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
) -> std::result::Result<super::ResolvedCodexConfig, super::Error> {
    let organization_id =
        super::super::validation::canonical_uuid(organization_id, "organization id")?;
    let conversation_id =
        super::super::validation::canonical_uuid(conversation_id, "conversation id")?;
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

    let selected_agent_id = row
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(row.try_get::<Option<String>, _>("routed_agent_id")?);
    let agent_id: String = row.try_get("agent_id")?;
    if row.try_get::<String, _>("conversation_kind")? != "chat"
        || row.try_get::<String, _>("conversation_status")? != "active"
        || row.try_get::<String, _>("agent_runtime_type")? != "cursor"
        || matches!(
            row.try_get::<String, _>("agent_status")?.as_str(),
            "terminated" | "pending_approval"
        )
        || selected_agent_id.as_deref() != Some(agent_id.as_str())
    {
        return Err(invalid("selected Cursor Agent is unavailable"));
    }
    if host.cursor_runtime().is_none() || !host.has_trusted_executable_search_path() {
        return Err(unsupported(
            "the trusted local Cursor Agent installation is unavailable",
        ));
    }

    let raw_config: String = row.try_get("agent_runtime_config")?;
    let config: Value = serde_json::from_str(&raw_config)
        .map_err(|_| invalid("Cursor Agent runtime configuration is malformed"))?;
    let object = config
        .as_object()
        .ok_or_else(|| invalid("Cursor Agent configuration must be an object"))?;
    const ALLOWED: &[&str] = &[
        "profileId",
        "command",
        "cwd",
        "model",
        "effort",
        "reasoningEffort",
        "mode",
        "timeoutSec",
        "graceSec",
        "instructionsBundleMode",
        "instructionsRootPath",
        "instructionsEntryFile",
        "instructionsFilePath",
        "env",
        "heartbeat",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(unsupported(
            "an unrecognized Cursor Agent runtime setting is present",
        ));
    }
    runtime::validate_instruction_settings(object)?;
    let profile_id = bounded_string(object.get("profileId"), "profileId")?
        .unwrap_or_else(|| "default".to_owned());
    validate_profile_id(&profile_id)?;
    validate_command(object.get("command"))?;
    let timeout_sec = optional_bounded_seconds(object.get("timeoutSec"), "timeoutSec", 3600)?;
    let grace_sec = optional_bounded_nonzero_seconds(object.get("graceSec"), "graceSec", 60)?;
    let model_override: Option<String> = row.try_get("model_override")?;
    let model = model_override
        .filter(|value| !value.trim().is_empty())
        .or(bounded_string(object.get("model"), "model")?);
    if let Some(model) = &model {
        validate_model(model)?;
    }
    let effort_override: Option<String> = row.try_get("effort_override")?;
    let effort = effort_override
        .filter(|value| !value.trim().is_empty())
        .or(bounded_string(
            object.get("effort").or(object.get("reasoningEffort")),
            "effort",
        )?);
    if let Some(effort) = &effort {
        validate_effort(effort)?;
    }
    let cli_model = cursor_cli_model(model.as_deref(), effort.as_deref())?;
    let configured_mode = bounded_string(object.get("mode"), "mode")?;
    let mode = if row.try_get::<bool, _>("plan_mode")? {
        Some("plan".to_owned())
    } else {
        configured_mode
    };
    if let Some(mode) = &mode {
        validate_mode(mode)?;
    }
    if let Some(heartbeat) = object.get("heartbeat")
        && !matches!(heartbeat, Value::Null | Value::Object(_))
    {
        return Err(invalid("Cursor heartbeat policy must be an object"));
    }

    let env = resolve_agent_env(tx, &organization_id, object.get("env")).await?;
    let env_facts: Vec<Value> = env
        .iter()
        .map(|(key, value)| json!({"name":key,"sha256":fingerprint::digest(value.as_bytes())}))
        .collect();

    let issue_id: Option<String> = row.try_get("primary_issue_id")?;
    let (project_id, workspace_id) = if let Some(issue_id) = issue_id.as_deref() {
        let issue = sqlx::query(
            "SELECT project_id::text AS project_id, project_workspace_id::text AS workspace_id
             FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR SHARE",
        )
        .bind(&organization_id)
        .bind(issue_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| invalid("Chat primary issue is outside the organization"))?;
        (
            issue.try_get::<Option<String>, _>("project_id")?,
            issue.try_get::<Option<String>, _>("workspace_id")?,
        )
    } else {
        (None, None)
    };
    let workspace = resolve_issue_workspace(
        tx,
        &organization_id,
        issue_id.as_deref(),
        project_id.as_deref(),
        workspace_id.as_deref(),
    )
    .await?;
    let agent_row = json!({
        "id":agent_id,
        "orgId":organization_id,
        "name":row.try_get::<String,_>("agent_name")?,
        "role":row.try_get::<String,_>("agent_role")?,
        "workspaceKey":row.try_get::<Option<String>,_>("workspace_key")?,
        "agentRuntimeConfig":config,
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
    let configured_cwd = object.get("cwd").and_then(Value::as_str);
    let cwd = if let Some(workspace) = workspace.as_ref() {
        workspace.cwd.clone()
    } else if let Some(configured) = configured_cwd {
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
    if instructions
        .entry_content
        .as_ref()
        .is_some_and(|text| text.len() > MAX_TEXT_BYTES || text.chars().any(|c| c == '\0'))
    {
        return Err(unsupported(
            "resolved Agent instructions exceed the supported Cursor ACP bound",
        ));
    }
    let managed_instruction_workspace = issue_id.is_none()
        && workspace.is_none()
        && configured_cwd.is_none()
        && cwd == fallback_cwd;
    if instructions
        .entry_content
        .as_ref()
        .is_some_and(|text| !text.is_empty())
        && !managed_instruction_workspace
    {
        return Err(unsupported(
            "resolved Cursor instructions require the managed Agent fallback workspace",
        ));
    }

    let (_executable, profiles_root) = host.cursor_runtime().expect("checked above");
    let home = if profile_id == "operator-default" {
        resolve_operator_profile_home(host.operator_home())?
    } else {
        resolve_profile_home(profiles_root, &profile_id)?
    };
    let profile_config_revision = cursor_profile_revision(&home)?;
    let workspace_binding_id = issue_workspace_binding(&workspace);
    let revision = json!({
        "runtimeType":"cursor",
        "profileId":profile_id,
        "command":"cursor-agent",
        "timeoutSec":timeout_sec,
        "graceSec":grace_sec,
        "model":model,
        "effort":effort,
        "cliModel":cli_model,
        "mode":mode,
        "workspaceBindingId":workspace_binding_id,
        "effectiveCwd":cwd.to_string_lossy(),
        "env":env_facts,
        "instructionsRevision":instructions.revision,
        "profileConfigRevision":profile_config_revision,
    });
    let identity = super::RuntimeBindingIdentity {
        agent_id: agent_id.clone(),
        runtime_type: "cursor".into(),
        host_id: host.host_id().to_owned(),
        profile_id: format!("cursor-local:{}:{}", agent_id, profile_id),
        workspace_binding_id,
        instructions_revision: instructions.revision.clone(),
        capability_revision: fingerprint::json_revision(&revision),
    };
    Ok(super::ResolvedCodexConfig {
        identity,
        executable: host
            .cursor_runtime()
            .expect("checked above")
            .0
            .to_path_buf(),
        cwd,
        model: model.clone(),
        reasoning_effort: effort,
        plan_mode: mode.as_deref() == Some("plan"),
        search_enabled: false,
        bypass_approvals_and_sandbox: false,
        count_subscription_usage_as_cost: false,
        profile: super::ManagedCodexProfile {
            id: profile_id.clone(),
            home: home.clone(),
            native_managed: true,
        },
        operator_home: host.operator_home().to_path_buf(),
        executable_search_path: host.executable_search_path().to_owned(),
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
        hermes: None,
        pi: None,
        opencode: None,
        claude: None,
        cursor: Some(CursorLocalConfig {
            home,
            profile_id,
            executable_search_path: host.executable_search_path().to_owned(),
            model: model.clone(),
            cli_model,
            mode: mode.clone(),
            env_revision: fingerprint::json_revision(&json!(env_facts)),
            env,
            profile_config_revision,
            timeout_sec,
            grace_sec,
            managed_instruction_workspace,
            instruction_agent_id: agent_id,
            instruction_revision: instructions.revision,
        }),
    })
}

impl CursorLocalConfig {
    pub fn profile_revision_matches(&self) -> bool {
        cursor_profile_revision(&self.home)
            .is_ok_and(|revision| revision == self.profile_config_revision)
    }
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
            "profileId" => "Cursor profileId is invalid",
            "model" => "Cursor model is invalid",
            "effort" => "Cursor effort is invalid",
            _ => "Cursor runtime setting is invalid",
        })),
    }
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
        return Err(invalid("Cursor profileId is invalid"));
    }
    Ok(())
}

fn validate_command(value: Option<&Value>) -> Result<()> {
    match value {
        None => Ok(()),
        Some(Value::String(value)) if value == "cursor-agent" => Ok(()),
        Some(Value::String(_)) => Err(unsupported(
            "Cursor command must use the host-selected Cursor executable",
        )),
        Some(_) => Err(invalid("Cursor command is invalid")),
    }
}

fn optional_bounded_seconds(
    value: Option<&Value>,
    label: &'static str,
    max: u64,
) -> Result<Option<u64>> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| *value <= max)
            .map(Some)
            .ok_or_else(|| {
                invalid(match label {
                    "timeoutSec" => "Cursor timeoutSec is invalid",
                    _ => "Cursor runtime setting is invalid",
                })
            }),
        Some(_) => Err(invalid("Cursor runtime setting is invalid")),
    }
}

fn optional_bounded_nonzero_seconds(
    value: Option<&Value>,
    label: &'static str,
    max: u64,
) -> Result<Option<u64>> {
    let seconds = optional_bounded_seconds(value, label, max)?;
    if seconds.is_some_and(|value| value == 0) {
        return Err(invalid("Cursor graceSec must be between 1 and 60"));
    }
    Ok(seconds)
}

fn validate_model(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 512
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(invalid("Cursor model selection is invalid"));
    }
    Ok(())
}

/// Cursor's CLI accepts a model and its optional model-specific parameters as
/// one argument, e.g. `gpt-5.3-codex[effort=high]`. Resolve this while D1 still
/// holds the admission transaction so unsupported values cannot create a
/// message or run that the executor would later reject.
fn cursor_cli_model(model: Option<&str>, effort: Option<&str>) -> Result<Option<String>> {
    let Some(model) = model else {
        if effort.is_some() {
            return Err(unsupported(
                "Cursor effort requires an explicit model selection",
            ));
        }
        return Ok(None);
    };
    if model.is_empty()
        || model.trim() != model
        || model.len() > 512
        || model.chars().any(char::is_control)
    {
        return Err(invalid("Cursor model selection is invalid"));
    }

    let (base, raw_parameters) = match model.find('[') {
        None if model.contains(']') => return Err(invalid("Cursor model selection is invalid")),
        None => (model, None),
        Some(open) if model.ends_with(']') && open > 0 => {
            let raw = &model[open + 1..model.len() - 1];
            if raw.is_empty() || raw.contains('[') || raw.contains(']') {
                return Err(invalid("Cursor model selection is invalid"));
            }
            (&model[..open], Some(raw))
        }
        Some(_) => return Err(invalid("Cursor model selection is invalid")),
    };
    if !base.bytes().enumerate().all(|(index, byte)| {
        if index == 0 {
            byte.is_ascii_alphanumeric()
        } else {
            byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)
        }
    }) {
        return Err(invalid("Cursor model selection is invalid"));
    }

    let selected_effort = effort.map(str::to_ascii_lowercase);
    if selected_effort
        .as_deref()
        .is_some_and(|value| !["low", "medium", "high", "xhigh", "max", "auto"].contains(&value))
    {
        return Err(invalid("Cursor effort is invalid"));
    }

    let mut parameters = Vec::<(String, String)>::new();
    if let Some(raw_parameters) = raw_parameters
        && !raw_parameters.is_empty()
    {
        for parameter in raw_parameters.split(',') {
            let (raw_key, raw_value) = parameter
                .split_once('=')
                .ok_or_else(|| invalid("Cursor model parameter is invalid"))?;
            let key = raw_key.trim();
            let value = raw_value.trim();
            if key.is_empty()
                || value.is_empty()
                || key != raw_key
                || value != raw_value
                || value.bytes().any(|byte| byte.is_ascii_whitespace())
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                || value.chars().any(char::is_control)
            {
                return Err(invalid("Cursor model parameter is invalid"));
            }
            let normalized_value = value.to_ascii_lowercase();
            if key.eq_ignore_ascii_case("effort")
                && !["low", "medium", "high", "xhigh", "max", "auto"]
                    .contains(&normalized_value.as_str())
            {
                return Err(invalid("Cursor effort is invalid"));
            }
            parameters.push((key.to_owned(), value.to_owned()));
        }
    }

    let mut seen = std::collections::BTreeSet::new();
    if parameters
        .iter()
        .any(|(key, _)| !seen.insert(key.to_ascii_lowercase()))
    {
        return Err(invalid("Cursor model parameters must be unique"));
    }

    if let Some(effort) = selected_effort {
        parameters.retain(|(key, _)| !key.eq_ignore_ascii_case("effort"));
        if effort != "auto" {
            parameters.push(("effort".to_owned(), effort));
        }
    }

    if parameters.is_empty() {
        Ok(Some(base.to_owned()))
    } else {
        let values = parameters
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(",");
        Ok(Some(format!("{base}[{values}]")))
    }
}

fn validate_effort(value: &str) -> Result<()> {
    if !["low", "medium", "high", "xhigh", "max", "auto"].contains(&value) {
        return Err(invalid("Cursor effort is invalid"));
    }
    Ok(())
}

fn validate_mode(value: &str) -> Result<()> {
    if !["plan", "ask"].contains(&value) {
        return Err(invalid("Cursor mode is invalid"));
    }
    Ok(())
}

fn resolve_profile_home(root: &Path, profile_id: &str) -> Result<PathBuf> {
    let expected = if profile_id == "default" {
        root.to_path_buf()
    } else {
        root.join("profiles").join(profile_id)
    };
    let metadata = fs::symlink_metadata(&expected)
        .map_err(|_| invalid("selected Cursor profile is unavailable"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid("selected Cursor profile is not a real directory"));
    }
    let canonical = expected
        .canonicalize()
        .map_err(|_| invalid("selected Cursor profile is unavailable"))?;
    let root = root
        .canonicalize()
        .map_err(|_| invalid("Cursor profile root is unavailable"))?;
    if !canonical.starts_with(&root) {
        return Err(invalid("selected Cursor profile escaped its trusted root"));
    }
    let cursor_dir = canonical.join(".cursor");
    let cursor_meta = fs::symlink_metadata(&cursor_dir)
        .map_err(|_| invalid("selected Cursor profile has no .cursor directory"))?;
    if !cursor_meta.is_dir() || cursor_meta.file_type().is_symlink() {
        return Err(invalid("selected Cursor profile .cursor path is invalid"));
    }
    Ok(canonical)
}

fn resolve_operator_profile_home(operator_home: &Path) -> Result<PathBuf> {
    let canonical_home = operator_home
        .canonicalize()
        .map_err(|_| invalid("operator Cursor profile home is unavailable"))?;
    let expected_config_dir = canonical_home.join(".cursor");
    let config_meta = fs::symlink_metadata(&expected_config_dir)
        .map_err(|_| invalid("operator Cursor profile has no .cursor directory"))?;
    if !config_meta.is_dir() || config_meta.file_type().is_symlink() {
        return Err(invalid("operator Cursor profile .cursor path is invalid"));
    }
    let canonical_config_dir = expected_config_dir
        .canonicalize()
        .map_err(|_| invalid("operator Cursor profile .cursor path is invalid"))?;
    if canonical_config_dir != expected_config_dir {
        return Err(invalid("operator Cursor profile .cursor path is invalid"));
    }
    Ok(canonical_home)
}

fn cursor_profile_revision(home: &Path) -> Result<String> {
    const MAX: u64 = 1024 * 1024;
    let path = home.join(".cursor/settings.json");
    let facts = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => {
            return Err(invalid(
                "selected Cursor profile configuration is unavailable",
            ));
        }
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX => {
            return Err(invalid("selected Cursor profile configuration is invalid"));
        }
        Ok(meta) => {
            let bytes = fs::read(&path)
                .map_err(|_| invalid("selected Cursor profile configuration is unavailable"))?;
            if bytes.len() as u64 != meta.len() || bytes.len() as u64 > MAX {
                return Err(invalid("Cursor profile changed during resolution"));
            }
            vec![json!({"name":".cursor/settings.json","sha256":fingerprint::digest(&bytes)})]
        }
    };
    Ok(fingerprint::json_revision(&json!(facts)))
}

#[cfg(test)]
mod tests {
    use super::{
        cursor_cli_model, cursor_profile_revision, optional_bounded_nonzero_seconds,
        optional_bounded_seconds, resolve_operator_profile_home, validate_command, validate_effort,
        validate_mode, validate_profile_id,
    };
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn cursor_runtime_values_are_bounded() {
        assert!(validate_profile_id("default").is_ok());
        assert!(validate_profile_id("../escape").is_err());
        assert!(validate_effort("high").is_ok());
        assert!(validate_effort("turbo").is_err());
        assert!(validate_mode("ask").is_ok());
        assert!(validate_mode("autonomous").is_err());
    }

    #[test]
    fn operator_profile_requires_real_cursor_dir_and_hashes_its_settings() {
        let root = tempdir().unwrap();
        let operator_home = root.path().join("operator-home");
        fs::create_dir_all(operator_home.join(".cursor")).unwrap();
        let profile_home = resolve_operator_profile_home(&operator_home).unwrap();
        assert_eq!(profile_home, operator_home.canonicalize().unwrap());

        let settings = profile_home.join(".cursor/settings.json");
        fs::write(&settings, r#"{"model":"fixture-one"}"#).unwrap();
        let revision = cursor_profile_revision(&profile_home).unwrap();
        fs::write(&settings, r#"{"model":"fixture-two"}"#).unwrap();
        assert_ne!(
            revision,
            cursor_profile_revision(&profile_home).unwrap(),
            "operator Cursor settings must contribute to the selected profile revision"
        );
    }

    #[cfg(unix)]
    #[test]
    fn operator_profile_rejects_symlinked_cursor_dir() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let operator_home = root.path().join("operator-home");
        let redirected = root.path().join("redirected-cursor");
        fs::create_dir_all(&operator_home).unwrap();
        fs::create_dir_all(&redirected).unwrap();
        symlink(&redirected, operator_home.join(".cursor")).unwrap();
        assert!(resolve_operator_profile_home(&operator_home).is_err());
    }

    #[test]
    fn cursor_ui_defaults_have_typed_bounded_mappings() {
        assert!(validate_command(Some(&json!("cursor-agent"))).is_ok());
        assert!(validate_command(Some(&json!("/tmp/cursor-agent"))).is_err());
        assert!(matches!(
            optional_bounded_seconds(Some(&json!(0)), "timeoutSec", 3600),
            Ok(Some(0))
        ));
        assert!(matches!(
            optional_bounded_nonzero_seconds(Some(&json!(15)), "graceSec", 60),
            Ok(Some(15))
        ));
        assert!(optional_bounded_seconds(Some(&json!(3601)), "timeoutSec", 3600).is_err());
        assert!(optional_bounded_nonzero_seconds(Some(&json!(0)), "graceSec", 60).is_err());
    }

    #[test]
    fn cursor_cli_model_preserves_default_and_maps_parameterized_effort() {
        assert_eq!(
            cursor_cli_model(Some("auto"), None).unwrap().as_deref(),
            Some("auto")
        );
        assert_eq!(
            cursor_cli_model(Some("gpt-5.3-codex"), Some("high"))
                .unwrap()
                .as_deref(),
            Some("gpt-5.3-codex[effort=high]")
        );
        assert_eq!(
            cursor_cli_model(Some("gpt-5.3-codex[context=1m,effort=low]"), Some("high"))
                .unwrap()
                .as_deref(),
            Some("gpt-5.3-codex[context=1m,effort=high]")
        );
        assert_eq!(
            cursor_cli_model(Some("gpt-5.3-codex[context=1m,effort=low]"), Some("auto"))
                .unwrap()
                .as_deref(),
            Some("gpt-5.3-codex[context=1m]")
        );
        assert!(cursor_cli_model(None, Some("high")).is_err());
        for malformed in [
            "model[",
            "model]",
            "model[]",
            "model[a=1,a=2]",
            "model[effort=turbo]",
        ] {
            assert!(cursor_cli_model(Some(malformed), None).is_err());
        }
    }
}
