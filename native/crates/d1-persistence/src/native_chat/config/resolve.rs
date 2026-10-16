use super::{LocalHostContext, Result, fingerprint, invalid, runtime};
use crate::agent_core::instructions;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct ManagedCodexProfile {
    /// Stable, non-path identity persisted with the RuntimeBinding.
    pub id: String,
    /// Managed CODEX_HOME. The resolver never reads or creates this directory.
    pub home: PathBuf,
}

pub struct RuntimeBindingIdentity {
    pub agent_id: String,
    pub runtime_type: String,
    pub host_id: String,
    pub profile_id: String,
    pub workspace_binding_id: Option<String>,
    pub instructions_revision: String,
    pub capability_revision: String,
}

pub struct ResolvedCodexConfig {
    pub identity: RuntimeBindingIdentity,
    pub executable: PathBuf,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub plan_mode: bool,
    pub search_enabled: bool,
    pub profile: ManagedCodexProfile,
    pub instruction_source_path: Option<PathBuf>,
    /// Relative selected entry name, plus its bounded effective UTF-8 text.
    /// Instruction content is sensitive and intentionally has no `Debug` or
    /// serialization implementation on this result type.
    pub instruction_entry_file: String,
    pub instruction_content: Option<String>,
}

/// Resolve the selected Agent and all identity-bearing runtime inputs from the
/// transaction's persisted ordinary Chat state. Call only after the D1
/// authority has authenticated the actor; this function re-locks the
/// conversation and derives the selected Agent itself.
pub(crate) async fn resolve_codex_config(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
) -> std::result::Result<ResolvedCodexConfig, super::Error> {
    let organization_id =
        super::super::validation::canonical_uuid(organization_id, "organization id")?;
    let conversation_id =
        super::super::validation::canonical_uuid(conversation_id, "conversation id")?;
    let row = match sqlx::query(
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
    {
        Ok(Some(row)) => row,
        Ok(None) => return Err(invalid("Chat or selected Agent is unavailable")),
        Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("55P03") => {
            return Err(super::super::http(
                409,
                "Native Chat Agent is being changed or removed",
            ));
        }
        Err(error) => return Err(error.into()),
    };

    let conversation_status: String = row.try_get("conversation_status")?;
    let conversation_kind: String = row.try_get("conversation_kind")?;
    if conversation_kind != "chat" {
        return Err(invalid("only ordinary Chat conversations are supported"));
    }
    if conversation_status != "active" {
        return Err(invalid("Chat conversation is not active"));
    }
    let selected_agent = row
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(row.try_get::<Option<String>, _>("routed_agent_id")?)
        .ok_or_else(|| invalid("Chat conversation has no selected Agent"))?;
    let agent_id: String = row.try_get("agent_id")?;
    if selected_agent != agent_id {
        return Err(invalid("selected Agent changed during runtime resolution"));
    }
    let agent_status: String = row.try_get("agent_status")?;
    if matches!(agent_status.as_str(), "terminated" | "pending_approval") {
        return Err(invalid("selected Agent is unavailable"));
    }
    let runtime_type: String = row.try_get("agent_runtime_type")?;
    if runtime_type != "codex_local" {
        return Err(super::unsupported(
            "only the local Codex runtime is supported",
        ));
    }

    let raw_config: String = row.try_get("agent_runtime_config")?;
    let config: Value = serde_json::from_str(&raw_config)
        .map_err(|_| invalid("Agent runtime configuration is malformed"))?;
    let model_override: Option<String> = row.try_get("model_override")?;
    let effort_override: Option<String> = row.try_get("effort_override")?;
    let plan_mode: bool = row.try_get("plan_mode")?;
    let settings = runtime::parse_agent_config(
        config.clone(),
        model_override,
        effort_override,
        plan_mode,
        host.operator_home(),
    )?;
    if let Some(configured_command) = &settings.command {
        let canonical = configured_command
            .canonicalize()
            .map_err(|_| super::unsupported("configured Codex command is unavailable"))?;
        if canonical != host.codex_executable() {
            return Err(super::unsupported(
                "configured Codex command does not match the installed executable",
            ));
        }
    }

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
    } else if let Some(cwd) = &settings.cwd_override {
        canonical_cwd(cwd)?
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

    let profile_home = managed_profile_home(
        host.managed_profiles_root(),
        &organization_id,
        &agent_id,
        &settings.profile_id,
    )?;
    let profile_id = format!("managed-codex:{}:{}", agent_id, settings.profile_id);
    let workspace_binding_id = issue_workspace_binding(&workspace);
    let mut revision_input = settings.capability_revision_input;
    revision_input["effectiveCwd"] = json!(cwd.to_string_lossy());
    revision_input["workspaceBindingId"] = json!(workspace_binding_id);
    let capability_revision = fingerprint::json_revision(&revision_input);

    Ok(ResolvedCodexConfig {
        identity: RuntimeBindingIdentity {
            agent_id,
            runtime_type,
            host_id: host.host_id().to_owned(),
            profile_id: profile_id.clone(),
            workspace_binding_id,
            instructions_revision: instructions.revision,
            capability_revision,
        },
        executable: host.codex_executable().to_path_buf(),
        cwd,
        model: settings.model,
        reasoning_effort: settings.effort,
        plan_mode: settings.plan_mode,
        search_enabled: settings.search_enabled,
        profile: ManagedCodexProfile {
            id: profile_id,
            home: profile_home,
        },
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
    })
}

struct ResolvedWorkspace {
    id: String,
    cwd: PathBuf,
}

fn issue_workspace_binding(workspace: &Option<ResolvedWorkspace>) -> Option<String> {
    workspace.as_ref().map(|workspace| workspace.id.clone())
}

async fn resolve_issue_workspace(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    issue_id: Option<&str>,
    project_id: Option<&str>,
    issue_workspace_id: Option<&str>,
) -> Result<Option<ResolvedWorkspace>> {
    if issue_id.is_none() {
        return Ok(None);
    }
    if let Some(workspace_id) = issue_workspace_id {
        let rows = workspace_rows(tx, organization_id, workspace_id, project_id).await?;
        if rows.len() != 1 {
            return Err(invalid("Chat issue workspace is unavailable or mismatched"));
        }
        return Ok(Some(validate_workspace(
            rows.into_iter().next().expect("one row"),
        )?));
    }
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT w.id::text AS id, w.project_id::text AS project_id, w.cwd,
                w.source_type, w.visibility, w.setup_command, w.cleanup_command,
                w.remote_provider, w.remote_workspace_ref, w.shared_workspace_key,
                p.execution_workspace_policy::text AS workspace_policy
         FROM project_workspaces w
         JOIN projects p ON p.org_id=w.org_id AND p.id=w.project_id
         WHERE w.org_id=$1::uuid AND w.project_id=$2::uuid AND w.is_primary=true
         ORDER BY w.id
         FOR SHARE OF w, p",
    )
    .bind(organization_id)
    .bind(project_id)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() != 1 {
        return Err(invalid(
            "Chat issue project must have exactly one primary workspace",
        ));
    }
    Ok(Some(validate_workspace(
        rows.into_iter().next().expect("one row"),
    )?))
}

async fn workspace_rows(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    workspace_id: &str,
    project_id: Option<&str>,
) -> Result<Vec<sqlx::postgres::PgRow>> {
    Ok(sqlx::query(
        "SELECT w.id::text AS id, w.project_id::text AS project_id, w.cwd,
                w.source_type, w.visibility, w.setup_command, w.cleanup_command,
                w.remote_provider, w.remote_workspace_ref, w.shared_workspace_key,
                p.execution_workspace_policy::text AS workspace_policy
         FROM project_workspaces w
         JOIN projects p ON p.org_id=w.org_id AND p.id=w.project_id
         WHERE w.org_id=$1::uuid AND w.id=$2::uuid
           AND ($3::uuid IS NULL OR w.project_id=$3::uuid)
         FOR SHARE OF w, p",
    )
    .bind(organization_id)
    .bind(workspace_id)
    .bind(project_id)
    .fetch_all(&mut **tx)
    .await?)
}

fn validate_workspace(row: sqlx::postgres::PgRow) -> Result<ResolvedWorkspace> {
    let policy: Option<String> = row.try_get("workspace_policy")?;
    if policy
        .as_deref()
        .is_some_and(|raw| raw != "{}" && raw != "null")
    {
        return Err(super::unsupported(
            "project execution workspace policy is configured",
        ));
    }
    let source_type: String = row.try_get("source_type")?;
    let visibility: String = row.try_get("visibility")?;
    let cwd: Option<String> = row.try_get("cwd")?;
    let setup: Option<String> = row.try_get("setup_command")?;
    let cleanup: Option<String> = row.try_get("cleanup_command")?;
    let remote_provider: Option<String> = row.try_get("remote_provider")?;
    let remote_ref: Option<String> = row.try_get("remote_workspace_ref")?;
    let shared_key: Option<String> = row.try_get("shared_workspace_key")?;
    if source_type != "local_path"
        || visibility != "default"
        || setup.is_some()
        || cleanup.is_some()
        || remote_provider.is_some()
        || remote_ref.is_some()
        || shared_key.is_some()
    {
        return Err(super::unsupported(
            "project workspace is not a plain local path",
        ));
    }
    let cwd = cwd.ok_or_else(|| invalid("primary project workspace has no cwd"))?;
    let id: String = row.try_get("id")?;
    Ok(ResolvedWorkspace {
        id,
        cwd: canonical_cwd(Path::new(&cwd))?,
    })
}

fn canonical_cwd(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(invalid("resolved cwd must be absolute and normalized"));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| invalid("resolved cwd is unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(super::unsupported(
            "resolved cwd must be a real local directory",
        ));
    }
    path.canonicalize()
        .map_err(|_| invalid("resolved cwd is unavailable"))
}

fn validate_managed_cwd(path: &Path, workspace_home: &Path) -> Result<PathBuf> {
    if path.starts_with(workspace_home) {
        let canonical = canonical_cwd(path)?;
        if canonical.starts_with(workspace_home) {
            return Ok(canonical);
        }
    }
    Err(invalid("managed Agent cwd escaped its trusted workspace"))
}

fn managed_profile_home(
    root: &Path,
    organization_id: &str,
    agent_id: &str,
    profile_id: &str,
) -> Result<PathBuf> {
    let expected = root.join(organization_id).join(agent_id).join(profile_id);
    let mut cursor = expected.as_path();
    while !cursor.exists() {
        cursor = cursor
            .parent()
            .ok_or_else(|| invalid("managed Codex profile path is invalid"))?;
    }
    let existing = cursor
        .canonicalize()
        .map_err(|_| invalid("managed Codex profile root is unavailable"))?;
    if !existing.starts_with(root) {
        return Err(invalid(
            "managed Codex profile path escaped its trusted root",
        ));
    }
    if expected.exists() {
        let canonical = expected
            .canonicalize()
            .map_err(|_| invalid("managed Codex profile path is unavailable"))?;
        if !canonical.starts_with(root) || !canonical.is_dir() {
            return Err(invalid(
                "managed Codex profile path escaped its trusted root",
            ));
        }
        Ok(canonical)
    } else {
        Ok(expected)
    }
}
