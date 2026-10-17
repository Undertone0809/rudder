use super::{LocalHostContext, Result, fingerprint, invalid, runtime, unsupported};
use crate::agent_core::instructions;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

pub struct ManagedCodexProfile {
    /// Stable, non-path identity persisted with the RuntimeBinding.
    pub id: String,
    /// Selected CODEX_HOME. The resolver never creates or modifies it.
    pub home: PathBuf,
    /// True only when the trusted Rust host explicitly selected the existing
    /// per-Agent Rudder Codex home; false for isolated synthetic fixtures.
    pub native_managed: bool,
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
    /// True only when the trusted Agent config requests the same bypass policy
    /// already effective in the selected Codex profile.
    pub bypass_approvals_and_sandbox: bool,
    /// Existing Codex billing preference. Native finalization uses only
    /// provider-reported usage/cost and never fabricates an estimate.
    pub count_subscription_usage_as_cost: bool,
    pub profile: ManagedCodexProfile,
    /// Trusted operator HOME used by the established local Codex auth/config
    /// flow. The path is never accepted from a request or serialized.
    pub operator_home: PathBuf,
    /// Trusted child executable search path; only this host-provided value is
    /// inherited by Codex so configured native MCP commands remain resolvable.
    pub executable_search_path: String,
    pub instruction_source_path: Option<PathBuf>,
    /// Relative selected entry name, plus its bounded effective UTF-8 text.
    /// Instruction content is sensitive and intentionally has no `Debug` or
    /// serialization implementation on this result type.
    pub instruction_entry_file: String,
    pub instruction_content: Option<String>,
    /// Provider-specific resolved data. The Codex public carrier remains
    /// source-compatible; Hermes execution reads only this closed branch.
    pub hermes: Option<super::HermesLocalConfig>,
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
    if host.uses_native_codex_profile() && !host.has_trusted_executable_search_path() {
        return Err(invalid(
            "selected native Codex profile requires trusted executable paths",
        ));
    }
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
    let native_managed_profile = host.uses_native_codex_profile();
    let settings = runtime::parse_agent_config_with_profile_defaults(
        config.clone(),
        model_override,
        effort_override,
        plan_mode,
        host.operator_home(),
        native_managed_profile,
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

    let (profile_home, profile_config_fingerprint) = if native_managed_profile {
        let home = match settings.profile_id.as_str() {
            "default" => {
                existing_agent_codex_home(host.instance_root(), &organization_id, &agent_id)?
            }
            "operator-default" => host
                .operator_codex_home()
                .ok_or_else(|| unsupported("the existing operator Codex Profile is unavailable"))?
                .to_path_buf(),
            _ => {
                return Err(unsupported(
                    "the selected native Codex Profile is unavailable",
                ));
            }
        };
        let revision = codex_profile_config_revision(&home)?;
        (home, Some(revision))
    } else {
        (
            managed_profile_home(
                host.managed_profiles_root(),
                &organization_id,
                &agent_id,
                &settings.profile_id,
            )?,
            None,
        )
    };
    let profile_id = format!("managed-codex:{}:{}", agent_id, settings.profile_id);
    let workspace_binding_id = issue_workspace_binding(&workspace);
    let mut revision_input = settings.capability_revision_input;
    revision_input["effectiveCwd"] = json!(cwd.to_string_lossy());
    revision_input["workspaceBindingId"] = json!(workspace_binding_id);
    revision_input["nativeManagedCodexProfile"] = json!(native_managed_profile);
    revision_input["selectedCodexProfileConfigRevision"] = json!(profile_config_fingerprint);
    revision_input["selectedCodexProfileLocationRevision"] = json!(fingerprint::digest(
        profile_home.to_string_lossy().as_bytes()
    ));
    if native_managed_profile {
        revision_input["nativeExecutableSearchPathRevision"] = json!(fingerprint::digest(
            host.executable_search_path().as_bytes()
        ));
    }
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
        bypass_approvals_and_sandbox: settings.bypass_approvals_and_sandbox,
        count_subscription_usage_as_cost: settings.count_subscription_usage_as_cost,
        profile: ManagedCodexProfile {
            id: profile_id,
            home: profile_home,
            native_managed: native_managed_profile,
        },
        operator_home: host.operator_home().to_path_buf(),
        executable_search_path: host.executable_search_path().to_owned(),
        instruction_source_path: instructions.source_path,
        instruction_entry_file: instructions.entry_file,
        instruction_content: instructions.entry_content,
        hermes: None,
    })
}

/// Resolve the same per-Agent CODEX_HOME used by the installed Codex adapter:
/// `<instance>/organizations/<org-storage-key>/codex-home/agents/<agent>`.
/// UUIDs are already canonicalized by the caller, so removing hyphens and
/// retaining the first twelve lowercase hex digits matches the shared runtime
/// storage-key rule without accepting a path fragment from the Agent config.
fn existing_agent_codex_home(
    instance_root: &Path,
    organization_id: &str,
    agent_id: &str,
) -> Result<PathBuf> {
    let organization_key = organization_id
        .bytes()
        .filter(|byte| *byte != b'-')
        .take(12)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase();
    if organization_key.len() != 12 {
        return Err(invalid("managed Codex organization identity is invalid"));
    }
    let expected = instance_root
        .join("organizations")
        .join(organization_key)
        .join("codex-home")
        .join("agents")
        .join(agent_id);
    let metadata = fs::symlink_metadata(&expected)
        .map_err(|_| invalid("selected managed Codex profile is unavailable"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid("selected managed Codex profile is not a directory"));
    }
    let canonical = expected
        .canonicalize()
        .map_err(|_| invalid("selected managed Codex profile is unavailable"))?;
    if canonical != expected || !canonical.starts_with(instance_root) {
        return Err(invalid(
            "selected managed Codex profile escaped its host root",
        ));
    }
    Ok(canonical)
}

/// Bind the selected profile's non-secret Codex configuration bytes into the
/// existing capability revision. Never read auth.json or return/log config
/// values; only the digest leaves this resolver.
fn codex_profile_config_revision(home: &Path) -> Result<String> {
    const MAX_CONFIG_BYTES: usize = 1024 * 1024;
    let path = home.join("config.toml");
    let bytes = match read_codex_config_nofollow(&path, MAX_CONFIG_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(fingerprint::digest(b"native-codex-config-absent-v1"));
        }
        Err(_) => {
            return Err(invalid(
                "selected Codex profile configuration is unavailable",
            ));
        }
    };
    Ok(fingerprint::digest(&bytes))
}

/// Read only a bounded regular config file without following a symlink or
/// blocking on a FIFO. The content stays in this function's caller and only a
/// one-way digest is retained by the resolver.
fn read_codex_config_nofollow(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    ensure_regular_config_file(&file)?;
    let mut bytes = Vec::with_capacity(limit.saturating_add(1));
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Codex profile config exceeds its size limit",
        ));
    }
    Ok(bytes)
}

fn ensure_regular_config_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Codex profile config is not a regular file",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Codex profile config is a reparse point",
            ));
        }
    }
    Ok(())
}

pub(super) struct ResolvedWorkspace {
    pub id: String,
    pub cwd: PathBuf,
}

pub(super) fn issue_workspace_binding(workspace: &Option<ResolvedWorkspace>) -> Option<String> {
    workspace.as_ref().map(|workspace| workspace.id.clone())
}

pub(super) async fn resolve_issue_workspace(
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

pub(super) fn canonical_cwd(path: &Path) -> Result<PathBuf> {
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

pub(super) fn validate_managed_cwd(path: &Path, workspace_home: &Path) -> Result<PathBuf> {
    if path.starts_with(workspace_home) {
        let canonical = canonical_cwd(path)?;
        if canonical.starts_with(workspace_home) {
            return Ok(canonical);
        }
    }
    Err(invalid("managed Agent cwd escaped its trusted workspace"))
}

pub(super) fn managed_profile_home(
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

#[cfg(test)]
mod selected_codex_config_tests {
    use super::read_codex_config_nofollow;
    use std::fs;

    #[test]
    fn profile_config_read_is_bounded_and_regular_file_only() {
        let root = tempfile::tempdir().expect("temporary Codex profile");
        let config = root.path().join("config.toml");
        fs::write(&config, b"safe profile config").expect("write fixture config");
        assert_eq!(
            read_codex_config_nofollow(&config, 32).expect("bounded config read"),
            b"safe profile config"
        );
        assert!(read_codex_config_nofollow(&config, 8).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn profile_config_read_does_not_follow_symlinks() {
        let root = tempfile::tempdir().expect("temporary Codex profile");
        let target = root.path().join("target.toml");
        let link = root.path().join("config.toml");
        fs::write(&target, b"safe profile config").expect("write fixture target");
        std::os::unix::fs::symlink(&target, &link).expect("create config symlink");
        assert!(read_codex_config_nofollow(&link, 32).is_err());
    }
}
