//! Hermes-local configuration resolved from the locked Agent and trusted host.
//! Plain and decrypted env values remain in this non-Debug, non-serializable
//! in-process value only.

use super::resolve::{issue_workspace_binding, resolve_issue_workspace, validate_managed_cwd};
use super::{LocalHostContext, Result, fingerprint, invalid, unsupported};
use crate::{agent_core::instructions, secrets};
use rudder_hermes_acp::{MAX_EPHEMERAL_INSTRUCTION_BYTES, resolve_instruction_bootstrap};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub struct HermesLocalConfig {
    pub home: PathBuf,
    pub profile_id: String,
    /// Search path captured by the trusted Rust host, never by Agent config.
    pub executable_search_path: String,
    /// The selected Hermes venv interpreter, present only when resolved Agent
    /// instructions require the supported ephemeral ACP hook.
    pub instruction_python_executable: Option<PathBuf>,
    /// Trusted installation source root for the selected Hermes runtime.
    pub instruction_python_source_root: Option<PathBuf>,
    /// Fingerprint of the exact pinned Hermes 0.21.0 adapter surface.
    pub instruction_adapter_revision: Option<String>,
    pub profile_config_revision: String,
    /// Effective private environment. Never serialize or format this value.
    pub env: BTreeMap<String, String>,
    pub env_revision: String,
}

pub(super) struct HermesRuntimeSettings {
    pub(super) profile_id: String,
    pub(super) model: Option<String>,
    pub(super) env: Option<Value>,
}

/// Resolve one locked ordinary Chat's selected Hermes Agent. It intentionally
/// does not invoke Codex profile, workspace-policy, or Thread validation.
pub(crate) async fn resolve_hermes_config(
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
    let resolved_agent_id: String = row.try_get("agent_id")?;
    if row.try_get::<String, _>("conversation_kind")? != "chat"
        || row.try_get::<String, _>("conversation_status")? != "active"
        || row.try_get::<String, _>("agent_runtime_type")? != "hermes_local"
        || matches!(
            row.try_get::<String, _>("agent_status")?.as_str(),
            "terminated" | "pending_approval"
        )
        || selected_agent_id.as_deref() != Some(resolved_agent_id.as_str())
    {
        return Err(invalid("selected Hermes Agent is unavailable"));
    }
    if host.hermes_executable().is_none()
        || host.hermes_profiles_root().is_none()
        || !host.has_trusted_executable_search_path()
    {
        return Err(unsupported(
            "the trusted local Hermes installation is unavailable",
        ));
    }

    let raw_config: String = row.try_get("agent_runtime_config")?;
    let config: Value = serde_json::from_str(&raw_config)
        .map_err(|_| invalid("Agent runtime configuration is malformed"))?;
    let model_override: Option<String> = row.try_get("model_override")?;
    let chat_effort: Option<String> = row.try_get("effort_override")?;
    let settings = parse_runtime_settings(
        &config,
        model_override,
        chat_effort,
        row.try_get::<bool, _>("plan_mode")?,
    )?;
    let profile_id = settings.profile_id;
    let model = settings.model;
    // `parse_runtime_settings` rejects every non-empty reasoning effort until
    // Hermes ACP gains a verified setter mapping.
    let effort: Option<String> = None;
    let env = resolve_agent_env(tx, &organization_id, settings.env.as_ref()).await?;
    let env_facts: Vec<Value> = env
        .iter()
        .map(|(key, value)| json!({"name":key,"sha256":digest(value.as_bytes())}))
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
    let agent_id = resolved_agent_id;
    let agent_row = json!({
        "id":agent_id, "orgId":organization_id,
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
    let cwd = if let Some(workspace) = workspace.as_ref() {
        workspace.cwd.clone()
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
    let instruction_requires_bootstrap = instructions
        .entry_content
        .as_ref()
        .is_some_and(|text| !text.trim().is_empty());
    if instruction_requires_bootstrap
        && instructions.entry_content.as_ref().is_some_and(|text| {
            text.len() > MAX_EPHEMERAL_INSTRUCTION_BYTES || text.chars().any(|c| c == '\0')
        })
    {
        return Err(unsupported(
            "resolved Agent instructions exceed the supported Hermes bootstrap bound",
        ));
    }
    let executable = host
        .hermes_executable()
        .ok_or_else(|| unsupported("the trusted local Hermes installation is unavailable"))?;
    // Always validate the pinned bootstrap. Native Hermes must canonicalize the
    // selected profile route on every launch, including sessions with no extra
    // Agent instruction, so persisted provider metadata cannot hijack a resume.
    let instruction_bootstrap = Some(resolve_instruction_bootstrap(executable).map_err(|_| {
        unsupported("the installed Hermes version cannot safely apply profile canonicalization")
    })?);

    let profile_root = host.hermes_profiles_root().expect("checked above");
    let home = resolve_profile_home(profile_root, &profile_id)?;
    let workspace_binding_id = issue_workspace_binding(&workspace);
    let mut revision = json!({
        "runtimeType":"hermes_local", "profileId":profile_id,
        "model":model, "reasoningEffort":effort,
        "workspaceBindingId":workspace_binding_id,
        "effectiveCwd":cwd.to_string_lossy(), "env":env_facts,
        "instructionsRevision":instructions.revision,
        "instructionAdapterRevision":instruction_bootstrap.as_ref().map(|adapter| adapter.revision()),
    });
    // Bind the selected profile's non-secret configuration bytes. Do not read
    // Hermes state.db, credentials, or alter the profile.
    let profile_config_revision = hermes_profile_revision(&home)?;
    revision["profileConfigRevision"] = json!(profile_config_revision);
    let capability_revision = fingerprint::json_revision(&revision);
    let profile_ref = format!("hermes-local:{}:{}", agent_id, profile_id);
    let identity = super::RuntimeBindingIdentity {
        agent_id: agent_id.clone(),
        runtime_type: "hermes_local".into(),
        host_id: host.host_id().to_owned(),
        profile_id: profile_ref,
        workspace_binding_id,
        instructions_revision: instructions.revision,
        capability_revision,
    };
    Ok(super::ResolvedCodexConfig {
        identity,
        executable: host
            .hermes_executable()
            .expect("checked above")
            .to_path_buf(),
        cwd,
        model,
        reasoning_effort: effort,
        plan_mode: false,
        search_enabled: false,
        bypass_approvals_and_sandbox: false,
        count_subscription_usage_as_cost: false,
        executable_search_path: host.executable_search_path().to_owned(),
        profile: super::ManagedCodexProfile {
            id: profile_id.clone(),
            home: home.clone(),
            native_managed: true,
        },
        operator_home: host.operator_home().to_path_buf(),
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
        hermes: Some(HermesLocalConfig {
            home,
            profile_id,
            env,
            executable_search_path: host.executable_search_path().to_owned(),
            instruction_python_executable: instruction_bootstrap
                .as_ref()
                .map(|adapter| adapter.python_executable().to_path_buf()),
            instruction_python_source_root: instruction_bootstrap
                .as_ref()
                .map(|adapter| adapter.source_root().to_path_buf()),
            instruction_adapter_revision: instruction_bootstrap
                .as_ref()
                .map(|adapter| adapter.revision().to_owned()),
            profile_config_revision,
            env_revision: fingerprint::json_revision(&json!(env_facts)),
        }),
        pi: None,
        claude: None,
        cursor: None,
        opencode: None,
    })
}

impl HermesLocalConfig {
    /// Recheck the exact selected profile config files before provider effects.
    /// This never exposes their contents or secret values.
    pub fn profile_revision_matches(&self) -> bool {
        hermes_profile_revision(&self.home)
            .is_ok_and(|revision| revision == self.profile_config_revision)
    }

    /// Revalidate the selected installed adapter and exact helper surface
    /// before launching a child with resolved Agent instructions.
    pub fn instruction_adapter_matches(
        &self,
        hermes_executable: &Path,
        requires_adapter: bool,
    ) -> bool {
        match (
            self.instruction_adapter_revision.as_deref(),
            self.instruction_python_executable.as_deref(),
            self.instruction_python_source_root.as_deref(),
        ) {
            (Some(revision), Some(python), Some(source_root)) => {
                resolve_instruction_bootstrap(hermes_executable).is_ok_and(|adapter| {
                    adapter.revision() == revision
                        && adapter.python_executable() == python
                        && adapter.source_root() == source_root
                })
            }
            (None, None, None) => !requires_adapter,
            _ => false,
        }
    }
}

fn validate_heartbeat(value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Hermes heartbeat settings must be an object"))?;
    const ALLOWED: &[&str] = &[
        "enabled",
        "coolDownMs",
        "intervalMs",
        "preflight",
        "maxConcurrent",
        "wakeOnDemand",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(unsupported(
            "Hermes heartbeat settings contain an unsupported field",
        ));
    }
    if object.get("enabled").is_some_and(|v| !v.is_boolean())
        || object.get("preflight").is_some_and(|v| !v.is_boolean())
        || object.get("wakeOnDemand").is_some_and(|v| !v.is_boolean())
        || object
            .get("coolDownMs")
            .is_some_and(|v| v.as_u64().is_none_or(|n| n > 86_400_000))
        || object
            .get("intervalMs")
            .is_some_and(|v| v.as_u64().is_none_or(|n| !(1000..=86_400_000).contains(&n)))
        || object
            .get("maxConcurrent")
            .is_some_and(|v| v.as_u64().is_none_or(|n| !(1..=64).contains(&n)))
    {
        return Err(invalid("Hermes heartbeat settings are invalid"));
    }
    Ok(())
}

/// Shared strict Agent runtime-config admission for persisted Native Chat
/// resolution and the public preflight endpoint used before an Agent ID exists.
pub(super) fn parse_runtime_settings(
    config: &Value,
    model_override: Option<String>,
    effort_override: Option<String>,
    plan_mode: bool,
) -> Result<HermesRuntimeSettings> {
    let object = config
        .as_object()
        .ok_or_else(|| invalid("Hermes Agent configuration must be an object"))?;
    const ALLOWED: &[&str] = &[
        "profileId",
        "model",
        "modelFallbacks",
        "reasoningEffort",
        "env",
        "heartbeat",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(unsupported(
            "an unrecognized Hermes Agent runtime setting is present",
        ));
    }
    if object
        .get("modelFallbacks")
        .is_some_and(|fallbacks| !fallbacks.as_array().is_some_and(Vec::is_empty))
    {
        return Err(unsupported(
            "configured Hermes model fallbacks are not enabled for native Chat",
        ));
    }
    let profile_id = bounded_string(object.get("profileId"), "profileId")?
        .unwrap_or_else(|| "default".to_owned());
    validate_profile_id(&profile_id)?;
    let model = model_override
        .filter(|value| !value.trim().is_empty())
        .or(bounded_string(object.get("model"), "model")?);
    if let Some(model) = &model {
        validate_model(model)?;
    }
    let effort = effort_override
        .filter(|value| !value.trim().is_empty())
        .or(bounded_string(
            object.get("reasoningEffort"),
            "reasoningEffort",
        )?);
    if plan_mode {
        return Err(unsupported(
            "Hermes ACP has no verified Chat plan-mode mapping",
        ));
    }
    if let Some(effort) = &effort {
        // The installed Hermes ACP server exposes set_model and approval modes,
        // but no reasoning-effort setter. Reject instead of displaying an
        // Agent setting that the native provider would silently ignore.
        validate_effort(effort)?;
        return Err(unsupported(
            "the installed Hermes ACP protocol cannot apply reasoningEffort",
        ));
    }
    if let Some(heartbeat) = object.get("heartbeat") {
        validate_heartbeat(heartbeat)?;
    }
    Ok(HermesRuntimeSettings {
        profile_id,
        model,
        env: object.get("env").cloned(),
    })
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
            "profileId" => "Hermes profileId is invalid",
            "model" => "Hermes model is invalid",
            _ => "Hermes reasoningEffort is invalid",
        })),
    }
}

fn validate_model(value: &str) -> Result<()> {
    if value.len() > 512 || value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(invalid("Hermes model selection is invalid"));
    }
    Ok(())
}

fn validate_effort(value: &str) -> Result<()> {
    if ![
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ]
    .contains(&value)
    {
        return Err(invalid("Hermes reasoningEffort is invalid"));
    }
    Ok(())
}

pub(super) fn validate_profile_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(invalid("Hermes profileId is invalid"));
    }
    Ok(())
}

pub(super) fn resolve_profile_home(root: &Path, profile_id: &str) -> Result<PathBuf> {
    let expected = if profile_id == "default" {
        root.to_path_buf()
    } else {
        root.join("profiles").join(profile_id)
    };
    let metadata = fs::symlink_metadata(&expected)
        .map_err(|_| invalid("selected Hermes profile is unavailable"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid("selected Hermes profile is not a real directory"));
    }
    let canonical = expected
        .canonicalize()
        .map_err(|_| invalid("selected Hermes profile is unavailable"))?;
    let root = root
        .canonicalize()
        .map_err(|_| invalid("Hermes profile root is unavailable"))?;
    if !canonical.starts_with(&root) {
        return Err(invalid("selected Hermes profile escaped its trusted root"));
    }
    Ok(canonical)
}

pub(super) fn hermes_profile_revision(home: &Path) -> Result<String> {
    const MAX: u64 = 1024 * 1024;
    let mut facts = Vec::new();
    for name in ["config.yaml", "config.yml"] {
        let path = home.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(invalid(
                    "selected Hermes profile configuration is unavailable",
                ));
            }
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX => {
                return Err(invalid("selected Hermes profile configuration is invalid"));
            }
            Ok(meta) => {
                let bytes = fs::read(&path)
                    .map_err(|_| invalid("selected Hermes profile configuration is unavailable"))?;
                if bytes.len() as u64 != meta.len() || bytes.len() as u64 > MAX {
                    return Err(invalid("Hermes profile changed during resolution"));
                }
                facts.push(json!({"name":name,"sha256":digest(&bytes)}));
            }
        }
    }
    Ok(fingerprint::json_revision(&json!(facts)))
}

pub(crate) async fn resolve_agent_env(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    raw: Option<&Value>,
) -> Result<BTreeMap<String, String>> {
    let Some(raw) = raw else {
        return Ok(BTreeMap::new());
    };
    let object = raw
        .as_object()
        .ok_or_else(|| invalid("Hermes env must be an object"))?;
    if object.len() > 128 {
        return Err(unsupported("Hermes env has too many entries"));
    }
    let mut output = BTreeMap::new();
    let mut total = 0usize;
    for (name, binding) in object {
        if !valid_env_name(name) || protected_env_name(name) {
            return Err(unsupported(
                "Hermes env contains a protected or invalid name",
            ));
        }
        let value = if let Some(text) = binding.as_str() {
            text.to_owned()
        } else if binding.get("type").and_then(Value::as_str) == Some("plain")
            && binding
                .as_object()
                .is_some_and(|m| m.len() == 2 && m.contains_key("value"))
        {
            binding
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Hermes plain env binding is invalid"))?
                .to_owned()
        } else if binding.get("type").and_then(Value::as_str) == Some("secret_ref") {
            resolve_secret_ref(tx, org, binding).await?
        } else {
            return Err(invalid("Hermes env binding is invalid"));
        };
        total = total.saturating_add(name.len()).saturating_add(value.len());
        if value.len() > 32 * 1024 || total > 256 * 1024 || value.chars().any(|c| c == '\0') {
            return Err(unsupported(
                "Hermes environment exceeds the supported bound",
            ));
        }
        output.insert(name.clone(), value);
    }
    Ok(output)
}

async fn resolve_secret_ref(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    binding: &Value,
) -> Result<String> {
    let obj = binding
        .as_object()
        .ok_or_else(|| invalid("Hermes Secret reference is invalid"))?;
    if obj
        .keys()
        .any(|key| !["type", "secretId", "version"].contains(&key.as_str()))
    {
        return Err(invalid("Hermes Secret reference is invalid"));
    }
    let id = binding
        .get("secretId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Hermes Secret reference is invalid"))?;
    let id = super::super::validation::canonical_uuid(id, "Secret id")?;
    let selector = match binding.get("version") {
        None => None,
        Some(Value::String(value)) if value == "latest" => None,
        Some(Value::Number(value)) => Some(
            value
                .as_i64()
                .filter(|version| *version > 0)
                .and_then(|version| i32::try_from(version).ok())
                .ok_or_else(|| invalid("Hermes Secret version is invalid"))?,
        ),
        _ => return Err(invalid("Hermes Secret version selector is invalid")),
    };
    let row = sqlx::query(
        "SELECT s.provider,s.purpose,s.latest_version,v.version,v.material::text AS material,
                v.value_sha256,v.revoked_at IS NOT NULL AS revoked
         FROM organization_secrets s
         JOIN organization_secret_versions v ON v.secret_id=s.id
         WHERE s.org_id=$1::uuid AND s.id=$2::uuid
           AND v.version=CASE WHEN $3::boolean THEN s.latest_version ELSE $4::integer END
         FOR SHARE OF s,v",
    )
    .bind(org)
    .bind(&id)
    .bind(selector.is_none())
    .bind(selector.unwrap_or(0))
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| invalid("Hermes Secret reference is unavailable"))?;
    if row.try_get::<String, _>("provider")? != "local_encrypted"
        || row.try_get::<String, _>("purpose")? != "user_managed"
        || row.try_get::<bool, _>("revoked")?
    {
        return Err(unsupported(
            "Hermes Secret reference requires an active local encrypted user Secret",
        ));
    }
    let material: Value = serde_json::from_str(&row.try_get::<String, _>("material")?)
        .map_err(|_| invalid("Hermes Secret material is invalid"))?;
    let hash: String = row.try_get("value_sha256")?;
    secrets::decrypt_runtime_secret(&material, &hash)
        .ok_or_else(|| unsupported("local Hermes Secret is unavailable"))
}

fn valid_env_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && value.len() <= 256
}

fn protected_env_name(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    [
        "HOME",
        "USERPROFILE",
        "HERMES_HOME",
        "PATH",
        "PWD",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LD_",
        "DYLD_",
        "PYTHON",
        "RUDDER_",
    ]
    .iter()
    .any(|prefix| {
        if prefix.ends_with('_') {
            upper.starts_with(prefix)
        } else {
            upper == *prefix
        }
    })
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod readiness_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn readiness_uses_the_same_strict_hermes_config_and_profile_rules() {
        let accepted = parse_runtime_settings(
            &json!({"profileId":"default","modelFallbacks":[]}),
            None,
            None,
            false,
        )
        .expect("empty fallback metadata is a no-op in the shared runtime editor");
        assert_eq!(accepted.profile_id, "default");

        for config in [
            json!({"profileId":"default","modelFallbacks":["other-model"]}),
            json!({"profileId":"default","command":"hermes"}),
            json!({"profileId":"../outside"}),
        ] {
            assert!(
                parse_runtime_settings(&config, None, None, false).is_err(),
                "unsupported Hermes config was accepted: {config}"
            );
        }

        let root = tempfile::tempdir().expect("create profile fixture");
        assert!(
            resolve_profile_home(root.path(), "missing-profile").is_err(),
            "a named profile absent from the trusted root must be rejected"
        );
    }
}
