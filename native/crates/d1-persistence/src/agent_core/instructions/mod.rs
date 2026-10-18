//! Native instruction projection and idempotent read-time recovery. Host facts
//! contain installation placement only; persisted Agent configuration determines
//! mode, legacy migration, default content and the returned Library reference.
mod fs;
mod lock;
mod storage;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;
use super::{AgentCreateInstructionsBundle, common::*};
use fs::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs as disk, io,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Host {
    pub instance_root: String,
    pub workspace_home: String,
    pub previous_documents_root: String,
    pub friendly_workspace_home: bool,
    pub hostname: String,
}
fn validate_host(host: &Host, ctx: &Context<'_>) -> Result<()> {
    if host.hostname.is_empty()
        || [
            &host.instance_root,
            &host.workspace_home,
            &host.previous_documents_root,
            &ctx.request.home_directory,
            &ctx.request.process_working_directory,
        ]
        .iter()
        .any(|path| !Path::new(path).is_absolute())
    {
        return Err(http(400, "Invalid Agent instruction host facts"));
    }
    Ok(())
}
pub(super) fn agents_root(ctx: &Context<'_>) -> Result<PathBuf> {
    let host = ctx
        .request
        .instructions_host
        .as_ref()
        .ok_or_else(|| http(503, "Rust Agent instruction placement is unavailable"))?;
    validate_host(host, ctx)?;
    storage::root(host, ctx.org)
        .map(|(root, _)| root.join("agents"))
        .map_err(|_| http(500, "Internal server error"))
}
fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key]
        .as_str()
        .map(js_trim)
        .filter(|value| !value.is_empty())
}
fn relative(value: &str) -> io::Result<String> {
    let value = value.replace('\\', "/");
    let absolute = value.starts_with('/');
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => (),
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            part => parts.push(part),
        }
    }
    let output = parts.join("/");
    if output.is_empty() || output == ".." || output.starts_with("../") {
        Err(invalid(
            "Instructions file path must stay within the bundle root",
        ))
    } else {
        Ok(output)
    }
}
fn files(root: &Path) -> io::Result<Vec<String>> {
    fn walk(root: &Path, current: &Path, output: &mut Vec<String>) -> io::Result<()> {
        let Ok(entries) = disk::read_dir(current) else {
            return Ok(());
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                if ![
                    ".git",
                    ".nox",
                    ".pytest_cache",
                    ".ruff_cache",
                    ".tox",
                    ".venv",
                    "__pycache__",
                    "node_modules",
                    "venv",
                ]
                .contains(&name.as_str())
                {
                    walk(root, &entry.path(), output)?;
                }
            } else if kind.is_file()
                && ![".DS_Store", "Thumbs.db", "Desktop.ini"].contains(&name.as_str())
                && !name.starts_with(".rudder-write-probe-")
                && !name.starts_with("._")
                && !name.ends_with(".pyc")
                && !name.ends_with(".pyo")
            {
                output.push(
                    entry
                        .path()
                        .strip_prefix(root)
                        .map_err(io::Error::other)?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        Ok(())
    }
    let mut result = Vec::new();
    walk(root, root, &mut result)?;
    Ok(result)
}
fn defaults(ceo: bool) -> BTreeMap<String, String> {
    let content = if ceo {
        [
            ("MEMORY.md", include_str!("templates/ceo/MEMORY.md")),
            ("SOUL.md", include_str!("templates/ceo/SOUL.md")),
            ("TOOLS.md", include_str!("templates/ceo/TOOLS.md")),
        ]
    } else {
        [
            ("MEMORY.md", include_str!("templates/default/MEMORY.md")),
            ("SOUL.md", include_str!("templates/default/SOUL.md")),
            ("TOOLS.md", include_str!("templates/default/TOOLS.md")),
        ]
    };
    content
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
}
fn write_missing(root: &Path, relative_path: &str, body: &str) -> io::Result<()> {
    let target = root.join(relative(relative_path)?);
    if let Some(metadata) = lstat(&target)? {
        if metadata.file_type().is_symlink() {
            return Err(invalid("Instruction bundle target must not be a symlink"));
        }
        if metadata.is_file() {
            return Ok(());
        }
        return Err(invalid("Instruction bundle target is not a file"));
    }
    let parent = target
        .parent()
        .ok_or_else(|| invalid("Missing file parent"))?;
    assert_owned(root)?;
    let relative_parent = parent
        .strip_prefix(root)
        .map_err(|_| invalid("Instruction bundle parent escaped root"))?;
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        current.push(component.as_os_str());
        match lstat(&current)? {
            Some(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(invalid(
                    "Instruction bundle parent is not an owned directory",
                ));
            }
            Some(_) => (),
            None => {
                mkdir_private(&current)?;
                assert_owned(&current)?;
            }
        }
    }
    let temporary = parent.join(format!(".rudder-write-probe-{}", random()?));
    let result = (|| {
        new_file(&temporary, body.as_bytes())?;
        match publish_new(&temporary, &target) {
            Ok(()) => sync_dir(parent),
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists
                    && lstat(&target)?
                        .is_some_and(|m| m.is_file() && !m.file_type().is_symlink()) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    })();
    let _ = disk::remove_file(temporary);
    result
}

/// The database row is the durable source of truth for a private create
/// bundle. Files are deliberately kept as JSON text so this module can
/// replay a row after a process crash without depending on a live request.
#[derive(Clone, Debug)]
struct DurableBundle {
    entry_file: String,
    files: BTreeMap<String, String>,
    clear_legacy_prompt_template: bool,
}

fn durable_bundle(bundle: &AgentCreateInstructionsBundle) -> io::Result<DurableBundle> {
    // Validation owns the public boundary. Keep a second cheap check here so
    // rows constructed by a future caller cannot turn this into a path sink.
    let entry_file = bundle_path(&bundle.entry_file)?;
    validate_bundle_limits(&entry_file, &bundle.files)?;
    let mut casefolded = BTreeMap::new();
    casefolded.insert(entry_file.to_lowercase(), entry_file.clone());
    let mut files = BTreeMap::new();
    for (path, body) in &bundle.files {
        let path = bundle_path(path)?;
        if let Some(previous) = casefolded.insert(path.to_lowercase(), path.clone())
            && previous != path
        {
            return Err(invalid(
                "Instruction bundle paths collide on a case-insensitive host",
            ));
        }
        if files.insert(path, body.clone()).is_some() {
            return Err(invalid("Duplicate instruction bundle path"));
        }
    }
    Ok(DurableBundle {
        entry_file,
        files,
        clear_legacy_prompt_template: bundle.clear_legacy_prompt_template,
    })
}

fn validate_bundle_limits(entry_file: &str, files: &BTreeMap<String, String>) -> io::Result<()> {
    let limits = super::validation::MAX_INSTRUCTION_FILES;
    let path_limit = super::validation::MAX_INSTRUCTION_PATH_BYTES;
    let file_limit = super::validation::MAX_INSTRUCTION_FILE_BYTES;
    let bundle_limit = super::validation::MAX_INSTRUCTION_BUNDLE_BYTES;
    if entry_file.len() > path_limit || files.len() > limits {
        return Err(invalid("Instruction bundle exceeds its size limits"));
    }
    let mut total = entry_file.len();
    for (path, body) in files {
        if path.len() > path_limit || body.len() > file_limit {
            return Err(invalid("Instruction bundle exceeds its size limits"));
        }
        total = total
            .checked_add(path.len())
            .and_then(|size| size.checked_add(body.len()))
            .ok_or_else(|| invalid("Instruction bundle exceeds its size limits"))?;
        if total > bundle_limit {
            return Err(invalid("Instruction bundle exceeds its size limits"));
        }
    }
    Ok(())
}

fn bundle_path(value: &str) -> io::Result<String> {
    let value = value.replace('\\', "/");
    if value.is_empty()
        || value.starts_with('/')
        || value.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.contains(':')
                || part.chars().any(char::is_control)
        })
    {
        return Err(invalid(
            "Instructions file path must be a relative bundle path",
        ));
    }
    Ok(value)
}

pub(super) async fn enqueue_create_bundle(
    tx: &mut Tx<'_>,
    org: &str,
    agent_id: &str,
    bundle: &AgentCreateInstructionsBundle,
) -> Result<()> {
    let bundle = durable_bundle(bundle).map_err(|error| http(422, error.to_string()))?;
    let files =
        serde_json::to_value(&bundle.files).map_err(|_| http(500, "Internal server error"))?;
    sqlx::query(
        "INSERT INTO agent_instruction_bundles
           (agent_id,org_id,entry_file,files,clear_legacy_prompt_template,state,attempts,next_attempt_at)
         VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5,'pending',0,now())",
    )
    .bind(agent_id)
    .bind(org)
    .bind(&bundle.entry_file)
    .bind(files.to_string())
    .bind(bundle.clear_legacy_prompt_template)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) fn create_feature_enabled() -> bool {
    std::env::var("RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
}

fn decode_durable_bundle(
    entry_file: &str,
    files: &str,
    clear_legacy_prompt_template: bool,
) -> io::Result<DurableBundle> {
    if files.len() > super::validation::MAX_INSTRUCTION_BUNDLE_BYTES {
        return Err(invalid("Instruction bundle exceeds its size limits"));
    }
    let entry_file = bundle_path(entry_file)?;
    let value = super::json_boundary::parse(files).map_err(io::Error::other)?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("Invalid persisted instruction bundle files"))?;
    if object.len() > super::validation::MAX_INSTRUCTION_FILES {
        return Err(invalid("Instruction bundle exceeds its size limits"));
    }
    let mut output = BTreeMap::new();
    let mut casefolded = BTreeMap::new();
    casefolded.insert(entry_file.to_lowercase(), entry_file.to_owned());
    for (path, body) in object {
        let path = bundle_path(path)?;
        let body = body
            .as_str()
            .ok_or_else(|| invalid("Invalid persisted instruction bundle content"))?;
        if let Some(previous) = casefolded.insert(path.to_lowercase(), path.clone())
            && previous != path
        {
            return Err(invalid(
                "Instruction bundle paths collide on a case-insensitive host",
            ));
        }
        if output.insert(path, body.to_owned()).is_some() {
            return Err(invalid("Duplicate persisted instruction bundle path"));
        }
    }
    Ok(DurableBundle {
        entry_file,
        files: output,
        clear_legacy_prompt_template,
    })
    .and_then(|bundle| {
        validate_bundle_limits(&bundle.entry_file, &bundle.files)?;
        Ok(bundle)
    })
}

fn materialize_bundle_locked(
    host: &Host,
    org: &str,
    workspace_key: &str,
    bundle: &DurableBundle,
    cwd: &Path,
) -> io::Result<PathBuf> {
    if workspace_key.is_empty()
        || !workspace_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(invalid("Invalid Agent workspace key"));
    }
    // storage::ensure creates the organization layout. Reject a pre-existing
    // agents symlink before that call can follow it while creating children.
    if let Ok((storage_root, _)) = storage::root(host, org) {
        let agents = storage_root.join("agents");
        if lstat(&agents)?.is_some_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(invalid("Agent workspace root must not be a symlink"));
        }
    }
    let agents = storage::ensure(host, org, cwd)?.join("agents");
    assert_owned(&agents)?;
    let workspace = agents.join(workspace_key);
    let root = workspace.join("instructions");
    for directory in [&workspace, &root] {
        match lstat(directory)? {
            Some(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(invalid("Agent workspace is not an owned directory"));
            }
            Some(_) => assert_owned(directory)?,
            None => {
                mkdir_private(directory)?;
                assert_owned(directory)?;
            }
        }
    }
    for (path, body) in &bundle.files {
        write_missing(&root, path, body)?;
    }
    // Always pass the entry through write_missing so a symlink target is
    // rejected instead of being accepted through metadata() following it.
    write_missing(&root, &bundle.entry_file, "")?;
    Ok(root)
}

#[cfg(test)]
pub(super) fn materialize_bundle_for_test(
    host: &Host,
    org: &str,
    workspace_key: &str,
    bundle: &AgentCreateInstructionsBundle,
    cwd: &Path,
) -> io::Result<()> {
    validate_host_paths(host, cwd)?;
    let _guard = lock::Guard::acquire(Path::new(&host.workspace_home), &host.hostname)
        .map_err(|_| invalid("Instruction workspace lock unavailable"))?;
    let bundle = durable_bundle(bundle)?;
    materialize_bundle_locked(host, org, workspace_key, &bundle, cwd).map(|_| ())
}

#[cfg(test)]
fn validate_host_paths(host: &Host, cwd: &Path) -> io::Result<()> {
    if host.hostname.is_empty()
        || !cwd.is_absolute()
        || [
            &host.instance_root,
            &host.workspace_home,
            &host.previous_documents_root,
        ]
        .iter()
        .any(|path| !Path::new(path).is_absolute())
    {
        return Err(invalid("Invalid Agent instruction host facts"));
    }
    Ok(())
}
fn recover(host: &Host, row: &Value, home: &str, cwd: &str) -> io::Result<Value> {
    let org = text(row, "orgId");
    // NULL keys are backfilled by the caller before recovery. A persisted
    // blank key is intentionally not treated as missing: the Node adapter
    // keeps that stored value and the existing workspace-path contract fails
    // closed instead of writing into a derived directory.
    let workspace = if row["workspaceKey"].is_null() {
        super::reads::workspace_key(row)
    } else {
        js_trim(text(row, "workspaceKey")).to_owned()
    };
    if workspace.is_empty()
        || !workspace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(invalid("Invalid Agent workspace key"));
    }
    let root = storage::ensure(host, org, Path::new(cwd))?;
    let agent_root = root.join("agents").join(&workspace);
    let managed = agent_root.join("instructions");
    for directory in ["instructions", "memory", "life", "skills"] {
        disk::create_dir_all(agent_root.join(directory))?;
    }
    let config = &row["agentRuntimeConfig"];
    let mut mode = match config["instructionsBundleMode"].as_str() {
        Some("managed") => Some("managed"),
        Some("external") => Some("external"),
        _ => None,
    };
    let mut configured = string(config, "instructionsRootPath").map(|value| {
        let expanded = if value == "~" {
            home.to_owned()
        } else if let Some(tail) = value.strip_prefix("~/") {
            Path::new(home).join(tail).to_string_lossy().to_string()
        } else {
            value.to_owned()
        };
        path(&expanded, Path::new(cwd))
    });
    let mut entry = string(config, "instructionsEntryFile")
        .and_then(|value| relative(value).ok())
        .unwrap_or_else(|| "SOUL.md".into());
    let legacy_path = string(config, "instructionsFilePath").and_then(|value| {
        if Path::new(value).is_absolute() {
            Some(PathBuf::from(value))
        } else {
            string(config, "cwd")
                .filter(|cwd| Path::new(cwd).is_absolute())
                .map(|cwd| path(value, Path::new(cwd)))
        }
    });
    if configured.is_none()
        && let Some(legacy) = &legacy_path
    {
        configured = legacy.parent().map(Path::to_path_buf);
        entry = legacy
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        mode = Some(if legacy.starts_with(&managed) {
            "managed"
        } else {
            "external"
        });
    }
    let known = [
        Path::new(&host.instance_root)
            .join("organizations")
            .join(storage::key(org))
            .join("workspaces")
            .join("agents")
            .join(&workspace)
            .join("instructions"),
        Path::new(&host.previous_documents_root)
            .join("agents")
            .join(&workspace)
            .join("instructions"),
    ];
    let historical = |candidate: &Path| {
        let Some(instances) = Path::new(&host.instance_root).parent() else {
            return false;
        };
        let Ok(relative) = candidate.strip_prefix(instances) else {
            return false;
        };
        let parts = relative
            .iter()
            .map(|v| v.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        parts.len() == 7
            && parts[1] == "organizations"
            && (parts[2] == storage::key(org) || parts[2] == org)
            && parts[3] == "workspaces"
            && parts[4] == "agents"
            && parts[5] == workspace
            && parts[6] == "instructions"
    };
    let legacy_managed = configured.as_ref().is_some_and(|candidate| {
        let resolved = path(&candidate.to_string_lossy(), Path::new(cwd));
        resolved != managed && (known.contains(&resolved) || historical(&resolved))
    });
    if legacy_managed {
        mode = Some("managed");
        if let Some(source) = &configured
            && stat(source).is_some_and(|m| m.is_dir())
        {
            for file in files(source)? {
                let body = disk::read(source.join(&file))?;
                write_missing(&managed, &file, &String::from_utf8_lossy(&body))?;
            }
        }
        let mut content = defaults(text(row, "role") == "ceo");
        let legacy_body = legacy_path
            .as_ref()
            .and_then(|path| disk::read(path).ok())
            .map(|body| String::from_utf8_lossy(&body).into_owned())
            .or_else(|| string(config, "promptTemplate").map(str::to_owned))
            .unwrap_or_default();
        if !js_trim(&legacy_body).is_empty() {
            content.insert(entry.clone(), legacy_body);
        } else if !content.contains_key(&entry) {
            content.insert(
                entry.clone(),
                content.get("SOUL.md").cloned().unwrap_or_default(),
            );
        }
        for (file, body) in content {
            write_missing(&managed, &file, &body)?;
        }
        if !stat(&managed.join("MEMORY.md")).is_some_and(|m| m.is_file())
            && stat(&agent_root.join("MEMORY.md")).is_some_and(|m| m.is_file())
        {
            let memory = disk::read(agent_root.join("MEMORY.md"))?;
            write_missing(&managed, "MEMORY.md", &String::from_utf8_lossy(&memory))?;
        }
    }
    if !files(&managed)?.is_empty() && (configured.is_none() || mode != Some("external")) {
        mode = Some("managed");
    }
    // getBundle stats all referenced summaries even though detail only returns
    // this mode-derived path. Preserve observable filesystem failures.
    if let Some(configured) = configured
        && mode == Some("external")
    {
        for file in files(&configured)? {
            disk::metadata(configured.join(file))?;
        }
    }
    Ok(if mode == Some("managed") {
        json!(format!("agents/{workspace}/instructions"))
    } else {
        Value::Null
    })
}
pub(super) async fn library_path(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    row: &Value,
    native_auth: Option<&dyn super::NativeAgentAuthorizer>,
) -> Result<Value> {
    let host = ctx
        .request
        .instructions_host
        .clone()
        .ok_or_else(|| http(503, "Rust Agent instruction placement is unavailable"))?;
    validate_host(&host, ctx)?;
    let guard_host = host.clone();
    let guard = tokio::task::spawn_blocking(move || {
        lock::Guard::acquire(Path::new(&guard_host.workspace_home), &guard_host.hostname)
    })
    .await
    .map_err(|_| http(500, "Internal server error"))?
    .map_err(|_| http(500, "Internal server error"))?;
    // A credential can expire or be revoked while waiting for the filesystem
    // lock. Revalidate before recover() performs host writes; denial also
    // rolls back any uncommitted permissions update.
    super::revalidate_native_auth(native_auth, tx, ctx.org).await?;
    // A filesystem lock wait is also an authorization boundary. A revoked key,
    // membership or administrator role cannot use pre-wait authority.
    let admin=ctx.user().is_some() && sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(ctx.user()).fetch_one(&mut **tx).await?;
    let fresh = Context { admin, ..*ctx };
    authorize_org(tx, &fresh).await?;
    let row = row.clone();
    let home = ctx.request.home_directory.clone();
    let cwd = ctx.request.process_working_directory.clone();
    // The read path is the current private reconciler trigger. A future
    // background worker can claim rows using next_attempt_at, but this
    // foundation intentionally keeps recovery coupled to an authorized
    // detail request so host facts are always freshly signed.
    let pending = sqlx::query_as::<_, (String, String, bool)>(
        "SELECT entry_file,files::text,clear_legacy_prompt_template
           FROM agent_instruction_bundles
          WHERE org_id=$1::uuid AND agent_id=$2::uuid
            AND EXISTS (SELECT 1 FROM agents a WHERE a.id=agent_instruction_bundles.agent_id AND a.org_id=$1::uuid)
            AND state IN ('pending','repair')
          ORDER BY created_at
          LIMIT 1",
    )
    .bind(ctx.org)
    .bind(text(&row, "id"))
    .fetch_optional(&mut **tx)
    .await?;
    let has_pending = pending.is_some();
    let agent_id = text(&row, "id").to_owned();
    let org = ctx.org.to_owned();
    let pending_for_materializer = pending.clone();
    let materialized = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let (materialize_error, materialized_root) = pending_for_materializer
            .as_ref()
            .map(|(entry_file, files, clear_legacy)| {
                match decode_durable_bundle(entry_file, files, *clear_legacy) {
                    Ok(bundle) => match materialize_bundle_locked(
                        &host,
                        &org,
                        text(&row, "workspaceKey"),
                        &bundle,
                        Path::new(&cwd),
                    ) {
                        Ok(root) => (None, Some(root)),
                        Err(error) => (Some(error.to_string()), None),
                    },
                    Err(error) => (Some(error.to_string()), None),
                }
            })
            .unwrap_or((None, None));
        let recovered = recover(&host, &row, &home, &cwd);
        let recovery_error = recovered.as_ref().err().map(ToString::to_string);
        (
            recovered,
            materialize_error.or(recovery_error),
            materialized_root,
        )
    })
    .await
    .map_err(|_| http(500, "Internal server error"))?;
    let (recovered, materialize_error, materialized_root) = materialized;
    if has_pending {
        if let Some(error) = materialize_error {
            sqlx::query(
                "UPDATE agent_instruction_bundles
                    SET state='repair',attempts=attempts+1,next_attempt_at=now(),last_error=$3,updated_at=now()
                  WHERE org_id=$1::uuid AND agent_id=$2::uuid AND state IN ('pending','repair')",
            )
            .bind(ctx.org)
            .bind(&agent_id)
            .bind(error.chars().take(1024).collect::<String>())
            .execute(&mut **tx)
            .await?;
        } else {
            // Filesystem work happens outside the transaction. Re-check the
            // actor before committing the durable projection and its state;
            // revocation during materialization must leave the row replayable.
            super::revalidate_native_auth(native_auth, tx, ctx.org).await?;
            let admin = ctx.user().is_some()
                && sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')",
                )
                .bind(ctx.user())
                .fetch_one(&mut **tx)
                .await?;
            let fresh = Context { admin, ..*ctx };
            authorize_org(tx, &fresh).await?;
            let Some(managed_root) = materialized_root else {
                return Err(http(
                    500,
                    "Instruction bundle materialization did not produce a root",
                ));
            };
            let (entry_file, _, clear_legacy) = pending
                .as_ref()
                .expect("pending row exists when materializing");
            let managed_root = managed_root.to_string_lossy().into_owned();
            let managed_entry = Path::new(&managed_root).join(entry_file);
            let managed_entry = managed_entry.to_string_lossy().into_owned();
            sqlx::query(
                "UPDATE agents
                    SET agent_runtime_config =
                      ((COALESCE(agent_runtime_config,'{}'::jsonb)
                         || jsonb_build_object(
                              'instructionsBundleMode','managed',
                              'instructionsRootPath',$3::text,
                              'instructionsEntryFile',$4::text,
                              'instructionsFilePath',$5::text
                            ))
                        - CASE WHEN $6 THEN ARRAY['promptTemplate','bootstrapPromptTemplate']::text[] ELSE ARRAY[]::text[] END),
                        updated_at=now()
                  WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(ctx.org)
            .bind(&agent_id)
            .bind(&managed_root)
            .bind(entry_file)
            .bind(&managed_entry)
            .bind(*clear_legacy)
            .execute(&mut **tx)
            .await?;
            sqlx::query(
                "UPDATE agent_instruction_bundles
                    SET state='materialized',attempts=attempts+1,next_attempt_at=now(),last_error=NULL,materialized_at=now(),updated_at=now()
                  WHERE org_id=$1::uuid AND agent_id=$2::uuid AND state IN ('pending','repair')",
            )
            .bind(ctx.org)
            .bind(&agent_id)
            .execute(&mut **tx)
            .await?;
        }
    }
    recovered.map_err(|_| http(500, "Internal server error"))
}
