//! Claude Code local configuration resolved from the locked Agent and the
//! trusted Rust host. Secrets stay in the provider profile and are never
//! returned through this carrier.

use super::resolve::{issue_workspace_binding, resolve_issue_workspace, validate_managed_cwd};
use super::{LocalHostContext, Result, fingerprint, invalid, runtime, unsupported};
use crate::agent_core::instructions;
use crate::native_chat::config::resolve_agent_env;
use rudder_claude_code::MAX_USER_INPUT_BYTES;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

/// Trusted, provider-specific Claude Code installation facts. The profile
/// home is selected by Rust from the host-provided root and Agent profile ID;
/// it is never a path supplied by a request.
pub struct ClaudeLocalConfig {
    pub home: PathBuf,
    pub agent_home: PathBuf,
    pub memory_dir: PathBuf,
    /// Organization workspace root resolved from the same trusted host map
    /// used by Agent Run context. Populated for Goal runs only.
    pub organization_workspace_root: Option<PathBuf>,
    pub profile_id: String,
    pub executable_search_path: String,
    pub env: BTreeMap<String, String>,
    pub profile_config_revision: String,
    pub timeout_sec: Option<u64>,
    pub grace_sec: Option<u64>,
    pub permission_mode: Option<String>,
    pub max_turns_per_run: Option<u32>,
    /// Legacy runtime persona override used by wakeup templates. Durable Agent
    /// instructions remain independently resolved as the Claude system prompt.
    pub prompt_template: Option<String>,
    /// Bounded, same-directory instruction files selected from the resolved
    /// Agent bundle. The native Claude adapter inserts these after the entry
    /// using the legacy SOUL/TOOLS/MEMORY order.
    pub instruction_siblings: Vec<(String, String)>,
}

pub(crate) async fn resolve_claude_config(
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

    resolve_claude_config_for_row(tx, &organization_id, row, host).await
}

/// Resolve the same trusted Claude profile, workspace, environment, and
/// instructions for a Goal owner. No synthetic Chat conversation is created.
pub(crate) async fn resolve_goal_claude_config(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    goal_id: &str,
    agent_id: &str,
    host: &LocalHostContext,
) -> std::result::Result<super::ResolvedCodexConfig, super::Error> {
    let organization_id =
        super::super::validation::canonical_uuid(organization_id, "organization id")?;
    let goal_id = super::super::validation::canonical_uuid(goal_id, "Goal id")?;
    let agent_id = super::super::validation::canonical_uuid(agent_id, "Agent id")?;
    let row = sqlx::query(
        "/* native_goal_config_agent_lock */
         SELECT 'active'::text AS conversation_status, 'chat'::text AS conversation_kind,
                a.id::text AS preferred_agent_id, a.id::text AS routed_agent_id,
                NULL::text AS primary_issue_id, NULL::text AS model_override,
                NULL::text AS effort_override, false AS plan_mode,
                a.id::text AS agent_id, a.name AS agent_name, a.role AS agent_role,
                a.status AS agent_status, a.workspace_key,
                a.agent_runtime_type, a.agent_runtime_config::text AS agent_runtime_config
         FROM goals g
         JOIN agents a ON a.org_id=g.org_id AND a.id=g.owner_agent_id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND g.owner_agent_id=$3::uuid
           AND g.lifecycle='active' AND g.status='active'
         FOR UPDATE OF g FOR SHARE OF a NOWAIT",
    )
    .bind(&organization_id)
    .bind(&goal_id)
    .bind(&agent_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| match error {
        sqlx::Error::Database(ref database) if database.code().as_deref() == Some("55P03") => {
            super::http(409, "Goal owner Agent is being changed or removed")
        }
        other => other.into(),
    })?
    .ok_or_else(|| invalid("Active Goal or assigned Agent is unavailable"))?;

    let mut config = resolve_claude_config_for_row(tx, &organization_id, row, host).await?;
    let workspace_host = crate::agent_core::OrganizationWorkspaceHost {
        instance_root: host.instance_root().to_string_lossy().into_owned(),
        workspace_home: host.workspace_home().to_string_lossy().into_owned(),
        previous_documents_root: host
            .previous_documents_root()
            .to_string_lossy()
            .into_owned(),
        friendly_workspace_home: host.friendly_workspace_home(),
        hostname: host.host_id().to_owned(),
    };
    let organization_workspace_root =
        crate::agent_core::resolve_organization_workspace_root(&workspace_host, &organization_id)
            .map_err(|_| invalid("organization workspace context is unavailable"))?;
    let claude = config
        .claude
        .as_mut()
        .ok_or_else(|| invalid("resolved Goal Agent has no Claude configuration"))?;
    claude.organization_workspace_root = Some(organization_workspace_root);
    Ok(config)
}

async fn resolve_claude_config_for_row(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    row: PgRow,
    host: &LocalHostContext,
) -> std::result::Result<super::ResolvedCodexConfig, super::Error> {
    let selected_agent_id = row
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(row.try_get::<Option<String>, _>("routed_agent_id")?);
    let agent_id: String = row.try_get("agent_id")?;
    if row.try_get::<String, _>("conversation_kind")? != "chat"
        || row.try_get::<String, _>("conversation_status")? != "active"
        || row.try_get::<String, _>("agent_runtime_type")? != "claude_local"
        || matches!(
            row.try_get::<String, _>("agent_status")?.as_str(),
            "paused" | "terminated" | "pending_approval"
        )
        || selected_agent_id.as_deref() != Some(agent_id.as_str())
    {
        return Err(invalid("selected Claude Agent is unavailable"));
    }
    if host.claude_runtime().is_none() || !host.has_trusted_executable_search_path() {
        return Err(unsupported(
            "the trusted local Claude Code installation is unavailable",
        ));
    }

    let raw_config: String = row.try_get("agent_runtime_config")?;
    let config: Value = serde_json::from_str(&raw_config)
        .map_err(|_| invalid("Claude Agent runtime configuration is malformed"))?;
    let object = config
        .as_object()
        .ok_or_else(|| invalid("Claude Agent configuration must be an object"))?;
    const ALLOWED: &[&str] = &[
        "profileId",
        "command",
        "model",
        "effort",
        "reasoningEffort",
        "permissionMode",
        "dangerouslySkipPermissions",
        "maxTurnsPerRun",
        "promptTemplate",
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
            "an unrecognized Claude Agent runtime setting is present",
        ));
    }
    runtime::validate_instruction_settings(object)?;
    let profile_id = bounded_string(object.get("profileId"), "profileId")?
        .unwrap_or_else(|| "default".to_owned());
    validate_profile_id(&profile_id)?;
    validate_command(object.get("command"), "claude")?;
    let timeout_sec = optional_bounded_seconds(object.get("timeoutSec"), "timeoutSec", 3600)?;
    let grace_sec = optional_bounded_nonzero_seconds(object.get("graceSec"), "graceSec", 60)?;
    let max_turns_per_run = optional_bounded_turns(object.get("maxTurnsPerRun"))?;
    let prompt_template = optional_prompt_template(object.get("promptTemplate"))?;
    let dangerously_skip_permissions = match object.get("dangerouslySkipPermissions") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => {
            return Err(unsupported(
                "Claude dangerous permission bypass is not supported",
            ));
        }
        Some(_) => return Err(invalid("Claude dangerouslySkipPermissions must be false")),
    };
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
    let permission_mode = bounded_string(object.get("permissionMode"), "permissionMode")?;
    if let Some(mode) = &permission_mode {
        validate_permission_mode(mode)?;
    }
    if row.try_get::<bool, _>("plan_mode")? {
        return Err(unsupported(
            "Claude Code has no verified Chat plan-mode mapping",
        ));
    }
    if let Some(heartbeat) = object.get("heartbeat")
        && !matches!(heartbeat, Value::Null | Value::Object(_))
    {
        return Err(invalid("Claude heartbeat policy must be an object"));
    }

    let env = resolve_agent_env(tx, organization_id, object.get("env")).await?;
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
        .bind(organization_id)
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
        organization_id,
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
    let agent_home = instructions::managed_agent_workspace_path(
        host.instance_root(),
        host.workspace_home(),
        host.previous_documents_root(),
        host.friendly_workspace_home(),
        organization_id,
        &agent_row,
    )
    .map_err(|_| invalid("managed Agent workspace is unavailable"))?;
    let memory_dir = agent_home.join("memory");
    let cwd = if let Some(workspace) = workspace.as_ref() {
        workspace.cwd.clone()
    } else {
        validate_managed_cwd(&agent_home, host.workspace_home())?
    };
    let instructions = instructions::resolve_readonly_for_runtime(
        host.instance_root(),
        host.workspace_home(),
        host.previous_documents_root(),
        host.friendly_workspace_home(),
        organization_id,
        &agent_row,
        host.operator_home(),
        &cwd,
    )
    .map_err(|_| invalid("Agent instruction bundle cannot be resolved safely"))?;
    let instruction_siblings = instructions.sibling_content;
    if instructions
        .entry_content
        .as_ref()
        .is_some_and(|text| text.len() > MAX_USER_INPUT_BYTES || text.chars().any(|c| c == '\0'))
    {
        return Err(unsupported(
            "resolved Agent instructions exceed the supported Claude Code bound",
        ));
    }

    let (executable, profiles_root) = host.claude_runtime().expect("checked above");
    let home = if profile_id == "operator-default" {
        resolve_operator_profile_home(host.operator_home())?
    } else {
        resolve_profile_home(profiles_root, &profile_id)?
    };
    let profile_config_revision = claude_profile_revision(&home)?;
    let workspace_binding_id = issue_workspace_binding(&workspace);
    let revision = json!({
        "runtimeType":"claude_local",
        "profileId":profile_id,
        "command":"claude",
        "model":model,
        "effort":effort,
        "permissionMode":permission_mode,
        "dangerouslySkipPermissions":dangerously_skip_permissions,
        "maxTurnsPerRun":max_turns_per_run,
        "timeoutSec":timeout_sec,
        "graceSec":grace_sec,
        "workspaceBindingId":workspace_binding_id,
        "effectiveCwd":cwd.to_string_lossy(),
        "env":env_facts,
        "instructionsRevision":instructions.revision,
        "profileConfigRevision":profile_config_revision,
    });
    let identity = super::RuntimeBindingIdentity {
        agent_id: agent_id.clone(),
        runtime_type: "claude_local".into(),
        host_id: host.host_id().to_owned(),
        profile_id: format!("claude-local:{}:{}", agent_id, profile_id),
        workspace_binding_id,
        instructions_revision: instructions.revision,
        capability_revision: fingerprint::json_revision(&revision),
    };
    Ok(super::ResolvedCodexConfig {
        identity,
        executable: executable.to_path_buf(),
        cwd,
        model,
        reasoning_effort: effort,
        plan_mode: false,
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
        claude: Some(ClaudeLocalConfig {
            home,
            agent_home,
            memory_dir,
            organization_workspace_root: None,
            profile_id,
            executable_search_path: host.executable_search_path().to_owned(),
            env,
            profile_config_revision,
            timeout_sec,
            grace_sec,
            permission_mode,
            max_turns_per_run,
            prompt_template,
            instruction_siblings,
        }),
        cursor: None,
    })
}

impl ClaudeLocalConfig {
    pub fn profile_revision_matches(&self) -> bool {
        claude_profile_revision(&self.home)
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
            "profileId" => "Claude profileId is invalid",
            "model" => "Claude model is invalid",
            "effort" => "Claude effort is invalid",
            _ => "Claude runtime setting is invalid",
        })),
    }
}

fn optional_prompt_template(value: Option<&Value>) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(template)) if template.len() <= MAX_USER_INPUT_BYTES => {
            if template.contains('\0') {
                return Err(invalid(
                    "Claude promptTemplate contains an invalid character",
                ));
            }
            Ok(Some(template.clone()))
        }
        _ => Err(invalid("Claude promptTemplate exceeds the supported size")),
    }
}

fn validate_model(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(invalid("Claude model selection is invalid"));
    }
    Ok(())
}

fn validate_effort(value: &str) -> Result<()> {
    if !["low", "medium", "high", "xhigh", "max"].contains(&value) {
        return Err(invalid("Claude effort is invalid"));
    }
    Ok(())
}

fn validate_permission_mode(value: &str) -> Result<()> {
    if ![
        "acceptEdits",
        "auto",
        "default",
        "dontAsk",
        "manual",
        "plan",
    ]
    .contains(&value)
    {
        return Err(invalid("Claude permissionMode is invalid"));
    }
    if value == "plan" {
        return Err(unsupported("Claude plan permission mode is not enabled"));
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
        return Err(invalid("Claude profileId is invalid"));
    }
    Ok(())
}

fn validate_command(value: Option<&Value>, expected: &str) -> Result<()> {
    match value {
        None => Ok(()),
        Some(Value::String(value)) if value == expected => Ok(()),
        Some(Value::String(_)) => Err(unsupported(
            "Claude command must use the host-selected Claude executable",
        )),
        Some(_) => Err(invalid("Claude command is invalid")),
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
                    "timeoutSec" => "Claude timeoutSec is invalid",
                    _ => "Claude runtime setting is invalid",
                })
            }),
        Some(_) => Err(invalid("Claude runtime setting is invalid")),
    }
}

fn optional_bounded_nonzero_seconds(
    value: Option<&Value>,
    label: &'static str,
    max: u64,
) -> Result<Option<u64>> {
    let seconds = optional_bounded_seconds(value, label, max)?;
    if seconds.is_some_and(|value| value == 0) {
        return Err(invalid("Claude graceSec must be between 1 and 60"));
    }
    Ok(seconds)
}

fn optional_bounded_turns(value: Option<&Value>) -> Result<Option<u32>> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| (1..=1000).contains(value))
            .map(|value| Some(value as u32))
            .ok_or_else(|| invalid("Claude maxTurnsPerRun must be between 1 and 1000")),
        Some(_) => Err(invalid("Claude maxTurnsPerRun must be an integer")),
    }
}

fn resolve_profile_home(root: &Path, profile_id: &str) -> Result<PathBuf> {
    let expected = if profile_id == "default" {
        root.to_path_buf()
    } else {
        root.join("profiles").join(profile_id)
    };
    let metadata = fs::symlink_metadata(&expected)
        .map_err(|_| invalid("selected Claude profile is unavailable"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid("selected Claude profile is not a real directory"));
    }
    let canonical = expected
        .canonicalize()
        .map_err(|_| invalid("selected Claude profile is unavailable"))?;
    let root = root
        .canonicalize()
        .map_err(|_| invalid("Claude profile root is unavailable"))?;
    if !canonical.starts_with(&root) {
        return Err(invalid("selected Claude profile escaped its trusted root"));
    }
    let claude_dir = canonical.join(".claude");
    let claude_meta = fs::symlink_metadata(&claude_dir)
        .map_err(|_| invalid("selected Claude profile has no .claude directory"))?;
    if !claude_meta.is_dir() || claude_meta.file_type().is_symlink() {
        return Err(invalid("selected Claude profile .claude path is invalid"));
    }
    Ok(canonical)
}

fn resolve_operator_profile_home(operator_home: &Path) -> Result<PathBuf> {
    let canonical_home = operator_home
        .canonicalize()
        .map_err(|_| invalid("operator Claude profile home is unavailable"))?;
    let expected_config_dir = canonical_home.join(".claude");
    let config_meta = fs::symlink_metadata(&expected_config_dir)
        .map_err(|_| invalid("operator Claude profile has no .claude directory"))?;
    if !config_meta.is_dir() || config_meta.file_type().is_symlink() {
        return Err(invalid("operator Claude profile .claude path is invalid"));
    }
    let canonical_config_dir = expected_config_dir
        .canonicalize()
        .map_err(|_| invalid("operator Claude profile .claude path is invalid"))?;
    if canonical_config_dir != expected_config_dir {
        return Err(invalid("operator Claude profile .claude path is invalid"));
    }
    Ok(canonical_home)
}

fn claude_profile_revision(home: &Path) -> Result<String> {
    const MAX: u64 = 1024 * 1024;
    let mut facts = Vec::new();
    for name in [".claude/settings.json", ".claude/settings.local.json"] {
        let path = home.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(invalid(
                    "selected Claude profile configuration is unavailable",
                ));
            }
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX => {
                return Err(invalid("selected Claude profile configuration is invalid"));
            }
            Ok(meta) => {
                let bytes = fs::read(&path)
                    .map_err(|_| invalid("selected Claude profile configuration is unavailable"))?;
                if bytes.len() as u64 != meta.len() || bytes.len() as u64 > MAX {
                    return Err(invalid("Claude profile changed during resolution"));
                }
                facts.push(json!({"name":name,"sha256":fingerprint::digest(&bytes)}));
            }
        }
    }
    Ok(fingerprint::json_revision(&json!(facts)))
}

#[cfg(test)]
mod tests {
    use super::{
        claude_profile_revision, optional_bounded_nonzero_seconds, optional_bounded_seconds,
        optional_bounded_turns, resolve_operator_profile_home, validate_command, validate_effort,
        validate_permission_mode, validate_profile_id,
    };
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn claude_runtime_values_are_bounded() {
        assert!(validate_profile_id("default").is_ok());
        assert!(validate_profile_id("../escape").is_err());
        assert!(validate_effort("high").is_ok());
        assert!(validate_effort("turbo").is_err());
        assert!(validate_permission_mode("auto").is_ok());
        assert!(validate_permission_mode("plan").is_err());
    }

    #[test]
    fn operator_profile_requires_real_claude_dir_and_hashes_its_settings() {
        let root = tempdir().unwrap();
        let operator_home = root.path().join("operator-home");
        fs::create_dir_all(operator_home.join(".claude")).unwrap();
        let profile_home = resolve_operator_profile_home(&operator_home).unwrap();
        assert_eq!(profile_home, operator_home.canonicalize().unwrap());

        let settings = profile_home.join(".claude/settings.json");
        fs::write(&settings, r#"{"theme":"dark"}"#).unwrap();
        let revision = claude_profile_revision(&profile_home).unwrap();
        fs::write(&settings, r#"{"theme":"light"}"#).unwrap();
        assert_ne!(
            revision,
            claude_profile_revision(&profile_home).unwrap(),
            "operator Claude settings must contribute to the selected profile revision"
        );
    }

    #[cfg(unix)]
    #[test]
    fn operator_profile_rejects_symlinked_claude_dir() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let operator_home = root.path().join("operator-home");
        let redirected = root.path().join("redirected-claude");
        fs::create_dir_all(&operator_home).unwrap();
        fs::create_dir_all(&redirected).unwrap();
        symlink(&redirected, operator_home.join(".claude")).unwrap();
        assert!(resolve_operator_profile_home(&operator_home).is_err());
    }

    #[test]
    fn claude_ui_defaults_have_typed_bounded_mappings() {
        assert!(validate_command(Some(&json!("claude")), "claude").is_ok());
        assert!(validate_command(Some(&json!("/tmp/claude")), "claude").is_err());
        assert!(matches!(
            optional_bounded_seconds(Some(&json!(0)), "timeoutSec", 3600),
            Ok(Some(0))
        ));
        assert!(matches!(
            optional_bounded_nonzero_seconds(Some(&json!(15)), "graceSec", 60),
            Ok(Some(15))
        ));
        assert!(matches!(
            optional_bounded_turns(Some(&json!(300))),
            Ok(Some(300))
        ));
        assert!(optional_bounded_seconds(Some(&json!(3601)), "timeoutSec", 3600).is_err());
        assert!(optional_bounded_nonzero_seconds(Some(&json!(0)), "graceSec", 60).is_err());
        assert!(optional_bounded_turns(Some(&json!(0))).is_err());
    }
}
