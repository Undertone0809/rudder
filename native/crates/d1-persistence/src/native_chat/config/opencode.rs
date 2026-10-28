//! OpenCode-local configuration resolved from the locked Agent and an
//! explicitly owned Rust-host Server endpoint.
//!
//! The OpenCode Server is a provider-native process. This resolver only
//! carries its endpoint, selected model/agent and workspace identity into the
//! in-process executor; it never accepts a URL, token, plugin, or command from
//! an HTTP request.

use super::resolve::{issue_workspace_binding, resolve_issue_workspace, validate_managed_cwd};
use super::{LocalHostContext, Result, fingerprint, invalid, runtime, unsupported};
use crate::agent_core::instructions;
use rudder_opencode_native::OpenCodeClient;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;

mod compatibility;

/// Trusted OpenCode Server configuration. The bearer token is intentionally
/// exposed only through a narrow accessor and the type does not implement
/// `Debug` or serialization.
pub struct OpenCodeLocalConfig {
    server_url: Url,
    bearer_token: Option<String>,
    executable: Option<PathBuf>,
    system_instructions: Option<String>,
    profile_home: Option<PathBuf>,
    pub executable_search_path: String,
    pub profile_id: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub variant: Option<String>,
    pub timeout_sec: Option<u64>,
    pub cleanup_grace: Duration,
    pub agent: Option<String>,
    pub workspace: Option<String>,
    pub profile_config_revision: String,
}

impl OpenCodeLocalConfig {
    pub fn server_url(&self) -> &Url {
        &self.server_url
    }

    pub fn bearer_token(&self) -> Option<&str> {
        self.bearer_token.as_deref()
    }

    pub fn executable(&self) -> Option<&Path> {
        self.executable.as_deref()
    }

    pub fn append_system_instructions(&mut self, section: &str) {
        self.system_instructions = Some(match self.system_instructions.take() {
            Some(value) => format!("{value}\n\n{section}"),
            None => section.into(),
        });
    }

    pub fn system_instructions(&self) -> Option<&str> {
        self.system_instructions.as_deref()
    }

    pub fn profile_home(&self) -> Option<&Path> {
        self.profile_home.as_deref()
    }

    /// Recheck the endpoint shape before provider effects. The host owns the
    /// endpoint; this method only protects against an accidentally malformed
    /// in-memory value after resolution.
    pub fn endpoint_is_valid(&self) -> bool {
        self.executable.is_some()
            && owned_endpoint_is_valid(&self.server_url)
            && OpenCodeClient::new(self.server_url.clone(), self.bearer_token.clone()).is_ok()
    }
}

/// Resolve the selected OpenCode Agent from the locked ordinary Chat.
pub(crate) async fn resolve_opencode_config(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
) -> std::result::Result<super::ResolvedCodexConfig, super::Error> {
    let organization_id =
        super::super::validation::canonical_uuid(organization_id, "organization id")?;
    let conversation_id =
        super::super::validation::canonical_uuid(conversation_id, "conversation id")?;
    let (server_url, bearer_token) = host.opencode_runtime().ok_or_else(|| {
        unsupported("the trusted local OpenCode Server installation is unavailable")
    })?;
    let executable = host.opencode_executable().map(Path::to_path_buf);
    if executable.is_none() || !owned_endpoint_is_valid(server_url) {
        return Err(unsupported(
            "OpenCode native Chat requires an owned local Server executable and endpoint",
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

    let selected_agent_id = row
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(row.try_get::<Option<String>, _>("routed_agent_id")?);
    let agent_id: String = row.try_get("agent_id")?;
    let runtime_type = host.attempt_runtime(row.try_get("agent_runtime_type")?);
    let agent_status: String = row.try_get("agent_status")?;
    if row.try_get::<String, _>("conversation_kind")? != "chat"
        || row.try_get::<String, _>("conversation_status")? != "active"
        || selected_agent_id.as_deref() != Some(agent_id.as_str())
        || runtime_type != "opencode_local"
        || matches!(agent_status.as_str(), "terminated" | "pending_approval")
    {
        return Err(invalid("selected OpenCode Agent is unavailable"));
    }
    if row.try_get::<bool, _>("plan_mode")? {
        return Err(unsupported(
            "OpenCode native plan mode is not yet mapped to the shared Chat authority",
        ));
    }

    let raw_config: String = row.try_get("agent_runtime_config")?;
    let config: Value = serde_json::from_str(&raw_config)
        .map_err(|_| invalid("Agent runtime configuration is malformed"))?;
    let config = host.attempt_config(config);
    let object = config
        .as_object()
        .ok_or_else(|| invalid("OpenCode Agent configuration must be an object"))?;
    const ALLOWED: &[&str] = &[
        "profileId",
        "command",
        "timeoutSec",
        "graceSec",
        "cwd",
        "variant",
        "model",
        "agent",
        "workspace",
        "directory",
        "instructionsBundleMode",
        "instructionsRootPath",
        "instructionsEntryFile",
        "instructionsFilePath",
        "heartbeat",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(unsupported(
            "an unrecognized OpenCode Agent runtime setting is present",
        ));
    }
    if object
        .get("heartbeat")
        .is_some_and(|value| !value.is_null() && !value.is_object())
    {
        return Err(invalid("OpenCode heartbeat settings must be an object"));
    }

    runtime::validate_instruction_settings(object)?;
    match object.get("command") {
        None => {}
        Some(Value::String(command)) if command == "opencode" => {}
        _ => {
            return Err(unsupported(
                "OpenCode command must use the host-selected executable",
            ));
        }
    }
    let timeout_sec = bounded_seconds(object.get("timeoutSec"), 0, 3600)?;
    let cleanup_grace = cleanup_grace(object.get("graceSec"))?;
    // Legacy local OpenCode used the operator's native config/auth in place.
    // Preserve that choice when no selector was stored; explicit managed mode
    // must point at a provisioned, stable profile rather than a per-Run HOME.
    let profile_id = bounded_string(object.get("profileId"), "profileId")?.unwrap_or_else(|| {
        if executable.is_some() {
            "operator-default"
        } else {
            "default"
        }
        .to_owned()
    });
    validate_profile_id(&profile_id)?;
    let profile_home = match profile_id.as_str() {
        "default" if executable.is_some() => {
            let home = host
                .managed_profiles_root()
                .join("opencode")
                .join(&organization_id)
                .join(&agent_id)
                .join("default");
            if !home.is_dir() {
                return Err(unsupported(
                    "the selected managed OpenCode Profile is not provisioned",
                ));
            }
            Some(super::resolve::validate_managed_cwd(
                &home,
                host.managed_profiles_root(),
            )?)
        }
        "default" => None,
        "operator-default" if !host.opencode_operator_profile_supported() => {
            return Err(unsupported(
                "custom OpenCode config or XDG roots are not calibrated for native operator Profile",
            ));
        }
        "operator-default" if executable.is_some() => Some(host.operator_home().to_path_buf()),
        "operator-default" => {
            return Err(unsupported(
                "operator OpenCode Profile requires an owned local Server",
            ));
        }
        _ => return Err(unsupported("the selected OpenCode Profile is unavailable")),
    };
    if let Some(home) = profile_home.as_deref() {
        compatibility::validate_profile_database(home)?;
    }
    let profile_revision = profile_home
        .as_deref()
        .map(operator_profile_revision)
        .transpose()?;
    let model_override: Option<String> = host.attempt_chat_override(row.try_get("model_override")?);
    let model = model_override
        .filter(|value| !value.trim().is_empty())
        .or(bounded_string(object.get("model"), "model")?);
    if let Some(model) = model.as_deref() {
        validate_model(model)?;
    }
    let variant = host
        .attempt_chat_override(row.try_get::<Option<String>, _>("effort_override")?)
        .filter(|value| !value.trim().is_empty())
        .or(bounded_string(object.get("variant"), "variant")?);
    if let Some(variant) = &variant {
        validate_provider_id(variant, "OpenCode variant")?;
    }
    let agent = bounded_string(object.get("agent"), "agent")?;
    let workspace = bounded_string(object.get("workspace"), "workspace")?;
    let directory = bounded_string(object.get("directory"), "directory")?;
    let configured_cwd = bounded_string(object.get("cwd"), "cwd")?;
    if directory.is_some() && configured_cwd.is_some() && directory != configured_cwd {
        return Err(invalid(
            "OpenCode directory and cwd must identify the same workspace",
        ));
    }
    let configured_directory = directory.or(configured_cwd);
    if let Some(workspace) = workspace.as_deref() {
        validate_provider_id(workspace, "OpenCode workspace")?;
    }

    let issue_id: Option<String> = row.try_get("primary_issue_id")?;
    let (project_id, workspace_id) = if let Some(issue_id) = issue_id.as_deref() {
        let issue = sqlx::query(
            "SELECT project_id::text AS project_id,
                    project_workspace_id::text AS workspace_id
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
    let workspace_binding = resolve_issue_workspace(
        tx,
        &organization_id,
        issue_id.as_deref(),
        project_id.as_deref(),
        workspace_id.as_deref(),
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
    let cwd = if let Some(workspace) = workspace_binding.as_ref() {
        workspace.cwd.clone()
    } else if let Some(directory) = configured_directory.as_deref() {
        super::resolve::canonical_cwd(Path::new(directory))?
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
    let workspace_binding_id = issue_workspace_binding(&workspace_binding);
    let mut revision_input = json!({
        "runtimeType": "opencode_local",
        "profileId": profile_id,
        "model": model,
        "agent": agent,
        "workspace": workspace,
        "serverOrigin": server_url.origin().ascii_serialization(),
        "serverPath": server_url.path(),
        "workspaceBindingId": workspace_binding_id,
        "effectiveCwd": cwd.to_string_lossy(),
        "instructionsRevision": instructions.revision,
        "calibratedVersion": rudder_opencode_native::OPENCODE_CALIBRATED_VERSION,
        "profileConfigRevision": profile_revision,
        "timeoutSec": timeout_sec,
        "graceSec": cleanup_grace.as_secs(),
        "variant": variant,
    });
    revision_input["serverAuthConfigured"] = json!(bearer_token.is_some());
    let capability_revision = fingerprint::json_revision(&revision_input);
    let profile_kind = if profile_id == "operator-default" {
        "operator-opencode"
    } else {
        "managed-opencode"
    };
    let profile_ref = format!("{profile_kind}:{agent_id}:{profile_id}");
    let selected_home = profile_home
        .as_deref()
        .unwrap_or(host.operator_home())
        .to_path_buf();
    let opencode = OpenCodeLocalConfig {
        server_url: server_url.clone(),
        bearer_token: bearer_token.map(str::to_owned),
        executable,
        system_instructions: instructions.entry_content.clone(),
        profile_home,
        executable_search_path: host.executable_search_path().to_owned(),
        profile_id: profile_id.clone(),
        cwd: cwd.clone(),
        model: model.clone(),
        variant: variant.clone(),
        timeout_sec,
        cleanup_grace,
        agent,
        workspace,
        profile_config_revision: capability_revision.clone(),
    };
    Ok(super::ResolvedCodexConfig {
        identity: super::RuntimeBindingIdentity {
            agent_id,
            runtime_type,
            host_id: host.host_id().to_owned(),
            profile_id: profile_ref.clone(),
            workspace_binding_id,
            instructions_revision: instructions.revision,
            capability_revision,
        },
        // The historical carrier remains populated for source compatibility;
        // OpenCode execution must read only the provider extension below.
        executable: host.opencode_executable().map(Path::to_path_buf),
        cwd,
        model,
        reasoning_effort: variant,
        plan_mode: false,
        search_enabled: false,
        bypass_approvals_and_sandbox: false,
        count_subscription_usage_as_cost: false,
        profile: super::ManagedCodexProfile {
            id: profile_ref,
            home: selected_home,
            native_managed: true,
        },
        operator_home: host.operator_home().to_path_buf(),
        executable_search_path: host.executable_search_path().to_owned(),
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
        hermes: None,
        pi: None,
        claude: None,
        cursor: None,
        transport: None,
        model_attempt: None,
        opencode: Some(opencode),
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
            "profileId" => "OpenCode profileId is invalid",
            "model" => "OpenCode model is invalid",
            "agent" => "OpenCode agent is invalid",
            "workspace" => "OpenCode workspace is invalid",
            _ => "OpenCode directory is invalid",
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
        return Err(invalid("OpenCode profileId is invalid"));
    }
    Ok(())
}

fn owned_endpoint_is_valid(url: &Url) -> bool {
    url.scheme() == "http"
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && match url.host() {
            Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(host)) => host == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(_)) => false,
            None => false,
        }
}

fn cleanup_grace(value: Option<&Value>) -> Result<Duration> {
    Ok(Duration::from_secs(
        bounded_seconds(value, 1, 60)?.unwrap_or(20),
    ))
}

fn bounded_seconds(value: Option<&Value>, min: u64, max: u64) -> Result<Option<u64>> {
    match value {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|seconds| (min..=max).contains(seconds))
            .map(Some)
            .ok_or_else(|| invalid("OpenCode timeout or cleanup grace is invalid")),
    }
}

fn operator_profile_revision(home: &Path) -> Result<String> {
    const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
    let mut facts = Vec::new();
    for name in ["opencode.json", "opencode.jsonc", "config.json"] {
        let path = home.join(".config/opencode").join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > MAX_CONFIG_BYTES
                    || !path
                        .canonicalize()
                        .map_err(|_| invalid("OpenCode profile is unavailable"))?
                        .starts_with(home)
                {
                    return Err(invalid("OpenCode profile configuration is invalid"));
                }
                let bytes =
                    super::resolve::read_codex_config_nofollow(&path, MAX_CONFIG_BYTES as usize)
                        .map_err(|_| invalid("OpenCode profile is unavailable"))?;
                facts.push(json!({"file":name,"sha256":fingerprint::digest(&bytes)}));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                facts.push(json!({"file":name,"missing":true}))
            }
            Err(_) => return Err(invalid("OpenCode profile is unavailable")),
        }
    }
    Ok(fingerprint::json_revision(&json!(facts)))
}

fn validate_model(value: &str) -> Result<()> {
    validate_provider_id(value, "OpenCode model")?;
    if !value.contains('/') {
        return Err(invalid("OpenCode model must use provider/model form"));
    }
    Ok(())
}

fn validate_provider_id(value: &str, label: &'static str) -> Result<()> {
    if value.is_empty()
        || value.len() > 512
        || value.chars().any(char::is_control)
        || value.contains('\\')
        || value.starts_with('/')
    {
        return Err(invalid(label));
    }
    Ok(())
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    #[test]
    fn owned_server_endpoint_matches_the_process_host_transport() {
        for value in ["http://127.0.0.1:0/", "http://localhost/"] {
            assert!(owned_endpoint_is_valid(&Url::parse(value).unwrap()));
        }
        for value in [
            "https://127.0.0.1/",
            "http://[::1]/",
            "http://127.0.0.2/",
            "http://example.com/",
            "http://127.0.0.1/api",
            "http://127.0.0.1/?x=y",
            "http://name:secret@127.0.0.1/",
        ] {
            assert!(!owned_endpoint_is_valid(&Url::parse(value).unwrap()));
        }
    }

    #[test]
    fn cleanup_grace_preserves_native_default_and_rejects_invalid_values() {
        assert_eq!(cleanup_grace(None).unwrap(), Duration::from_secs(20));
        assert_eq!(
            cleanup_grace(Some(&json!(1))).unwrap(),
            Duration::from_secs(1)
        );
        assert_eq!(
            cleanup_grace(Some(&json!(60))).unwrap(),
            Duration::from_secs(60)
        );
        for value in [json!(0), json!(61), json!(1.5), json!("20")] {
            assert!(cleanup_grace(Some(&value)).is_err());
        }
    }
}
