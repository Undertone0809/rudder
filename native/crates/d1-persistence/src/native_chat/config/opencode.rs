//! OpenCode-local configuration resolved from the locked Agent and an
//! explicitly owned Rust-host Server endpoint.
//!
//! The OpenCode Server is a provider-native process. This resolver only
//! carries its endpoint, selected model/agent and workspace identity into the
//! in-process executor; it never accepts a URL, token, plugin, or command from
//! an HTTP request.

use super::resolve::{issue_workspace_binding, resolve_issue_workspace, validate_managed_cwd};
use super::{LocalHostContext, Result, fingerprint, invalid, unsupported};
use crate::agent_core::instructions;
use rudder_opencode_native::OpenCodeClient;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::path::{Path, PathBuf};
use url::Url;

/// Trusted OpenCode Server configuration. The bearer token is intentionally
/// exposed only through a narrow accessor and the type does not implement
/// `Debug` or serialization.
pub struct OpenCodeLocalConfig {
    server_url: Url,
    bearer_token: Option<String>,
    pub profile_id: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
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

    /// Recheck the endpoint shape before provider effects. The host owns the
    /// endpoint; this method only protects against an accidentally malformed
    /// in-memory value after resolution.
    pub fn endpoint_is_valid(&self) -> bool {
        matches!(self.server_url.scheme(), "http" | "https")
            && self.server_url.host_str().is_some()
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
    let runtime_type: String = row.try_get("agent_runtime_type")?;
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
    let object = config
        .as_object()
        .ok_or_else(|| invalid("OpenCode Agent configuration must be an object"))?;
    const ALLOWED: &[&str] = &[
        "profileId",
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

    let profile_id = bounded_string(object.get("profileId"), "profileId")?
        .unwrap_or_else(|| "default".to_owned());
    validate_profile_id(&profile_id)?;
    let model_override: Option<String> = row.try_get("model_override")?;
    let model = model_override
        .filter(|value| !value.trim().is_empty())
        .or(bounded_string(object.get("model"), "model")?);
    if let Some(model) = model.as_deref() {
        validate_model(model)?;
    }
    let agent = bounded_string(object.get("agent"), "agent")?;
    let workspace = bounded_string(object.get("workspace"), "workspace")?;
    let configured_directory = bounded_string(object.get("directory"), "directory")?;
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
    if instructions
        .entry_content
        .as_ref()
        .is_some_and(|text| !text.trim().is_empty())
    {
        return Err(unsupported(
            "OpenCode native Server has no verified system-instruction mapping yet",
        ));
    }

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
    });
    revision_input["serverAuthConfigured"] = json!(bearer_token.is_some());
    let capability_revision = fingerprint::json_revision(&revision_input);
    let profile_ref = format!("managed-opencode:{}:{}", agent_id, profile_id);
    let opencode = OpenCodeLocalConfig {
        server_url: server_url.clone(),
        bearer_token: bearer_token.map(str::to_owned),
        profile_id: profile_id.clone(),
        cwd: cwd.clone(),
        model: model.clone(),
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
        executable: host.codex_executable().to_path_buf(),
        cwd,
        model,
        reasoning_effort: None,
        plan_mode: false,
        search_enabled: false,
        bypass_approvals_and_sandbox: false,
        count_subscription_usage_as_cost: false,
        profile: super::ManagedCodexProfile {
            id: profile_ref,
            home: host.operator_home().to_path_buf(),
            native_managed: true,
        },
        operator_home: host.operator_home().to_path_buf(),
        executable_search_path: host.executable_search_path().to_owned(),
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
        hermes: None,
        pi: None,
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
