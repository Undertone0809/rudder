//! Native instruction projection and idempotent read-time recovery. Host facts
//! contain installation placement only; persisted Agent configuration determines
//! mode, legacy migration, default content and the returned Library reference.
mod fs;
mod lock;
mod read_only;
mod storage;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;
use super::{AgentCoreError, AgentCreateInstructionsBundle, common::*};
use fs::*;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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

/// Inspect an instruction root before any read or write traverses it. The
/// legacy `files()` walker intentionally skips links, which is useful for
/// ordinary discovery but unsafe as an authority boundary: a link or special
/// file should fail closed instead of silently changing the projected bundle.
fn preflight_root(root: &Path, allow_missing: bool) -> io::Result<()> {
    let Some(metadata) = lstat(root)? else {
        return if allow_missing {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Instruction bundle root is missing",
            ))
        };
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid(
            "Instruction bundle root must be an owned directory",
        ));
    }
    assert_owned(root)?;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in disk::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = lstat(&path)?.ok_or_else(|| {
                invalid("Instruction bundle changed while it was being inspected")
            })?;
            if metadata.file_type().is_symlink() {
                return Err(invalid("Instruction bundle contains a symbolic link"));
            }
            if metadata.is_dir() {
                assert_owned(&path)?;
                pending.push(path);
            } else if !metadata.is_file() {
                return Err(invalid(
                    "Instruction bundle contains an unsupported file type",
                ));
            }
        }
    }
    Ok(())
}

/// Validate a single file and every existing parent component without ever
/// following a symlink. This is used for legacy prompt migration and direct
/// file reads before `read`/`metadata` can touch a user-controlled path.
fn preflight_file(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Instruction file has no parent directory"))?;
    let mut current = parent.to_path_buf();
    let mut components = Vec::new();
    while let Some(component) = current.file_name() {
        components.push(component.to_owned());
        let Some(next) = current.parent() else { break };
        current = next.to_path_buf();
    }
    for component in components.iter().rev() {
        current.push(component);
        let Some(metadata) = lstat(&current)? else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Instruction file parent is missing",
            ));
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid("Instruction file parent is not an owned directory"));
        }
        assert_owned(&current)?;
    }
    let metadata = lstat(path)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Instruction file is missing"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid("Instruction file must be a regular file"));
    }
    Ok(())
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
    let relative_path = relative(relative_path)?;
    let target = root.join(&relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| invalid("Missing file parent"))?;

    // Never follow a symlink while materializing a durable instruction bundle.
    // Check every existing parent component as well as the final destination;
    // `metadata` would follow a link and make an outside path writable.
    let parent_relative = Path::new(&relative_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let mut current = root.to_path_buf();
    for component in parent_relative.components() {
        current.push(component.as_os_str());
        if let Some(metadata) = lstat(&current)?
            && (metadata.file_type().is_symlink() || !metadata.is_dir())
        {
            return Err(invalid("Instruction bundle parent must be a directory"));
        }
    }
    if let Some(metadata) = lstat(&target)? {
        if metadata.file_type().is_symlink() {
            return Err(invalid("Instruction bundle target must not be a symlink"));
        }
        if metadata.is_file() {
            return Ok(());
        }
        return Err(invalid("Instruction bundle target must be a regular file"));
    }
    disk::create_dir_all(parent)?;
    let temporary = parent.join(format!(".rudder-write-probe-{}", random()?));
    let result = (|| {
        {
            use std::io::Write;
            let mut file = disk::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(body.as_bytes())?;
            file.sync_all()?;
        }
        match publish_new(&temporary, &target) {
            Ok(()) => sync_dir(parent),
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists
                    && stat(&target).is_some_and(|m| m.is_file()) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    })();
    let _ = disk::remove_file(temporary);
    result
}

fn write_exact(root: &Path, relative_path: &str, body: &str) -> io::Result<()> {
    let target = root.join(relative(relative_path)?);
    if lstat(&target)?.is_some_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(invalid("Instruction bundle target must not be a symlink"));
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
        if lstat(&target)?.is_some_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(invalid("Instruction bundle target must not be a symlink"));
        }
        disk::rename(&temporary, &target)?;
        sync_dir(parent)
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
    deletions: Vec<String>,
    replace_existing: bool,
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
        deletions: Vec::new(),
        replace_existing: false,
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

struct BundleLocation {
    workspace: String,
    agent_root: PathBuf,
    managed: PathBuf,
    configured: Option<PathBuf>,
    entry: String,
    legacy_path: Option<PathBuf>,
    mode: Option<&'static str>,
    legacy_managed: bool,
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
    let deletions = match object.get("__rudderDeletes") {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                let path = value
                    .as_str()
                    .ok_or_else(|| invalid("Invalid persisted instruction deletion path"))?;
                bundle_path(path)
            })
            .collect::<io::Result<Vec<_>>>()?,
        Some(_) => return Err(invalid("Invalid persisted instruction deletion list")),
    };
    let replace_existing = object
        .get("__rudderReplace")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for (path, body) in object {
        if path == "__rudderDeletes" || path == "__rudderReplace" {
            continue;
        }
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
        deletions,
        replace_existing,
        clear_legacy_prompt_template,
    })
    .and_then(|bundle| {
        validate_bundle_limits(&bundle.entry_file, &bundle.files)?;
        Ok(bundle)
    })
}

/// Shared, pure path and legacy-mode resolution. Both mutating Agent recovery
/// and Native Chat's read-only identity resolver use this exact decision logic.
fn validate_workspace_for_io(
    host: &Host,
    org: &str,
    storage_root: &Path,
    workspace_key: &str,
) -> io::Result<()> {
    storage::validate_readonly(host, org, storage_root)?;
    let target = storage_root
        .join("agents")
        .join(workspace_key)
        .join("instructions");
    // Check every existing component before any recovery or materialization
    // call can create directories or follow a user supplied alias.
    storage::validate_readonly_path(storage_root, &target)
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
    // agents/workspace/instructions symlink or foreign organization identity
    // before that call can follow it while creating children.
    let (storage_root, _) = storage::root(host, org)?;
    validate_workspace_for_io(host, org, &storage_root, workspace_key)?;
    let agents = storage::ensure(host, org, cwd)?.join("agents");
    validate_workspace_for_io(host, org, agents.parent().unwrap_or(&agents), workspace_key)?;
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
        if bundle.replace_existing {
            write_exact(&root, path, body)?;
        } else {
            write_missing(&root, path, body)?;
        }
    }
    // Always pass the entry through write_missing so a symlink target is
    // rejected instead of being accepted through metadata() following it.
    write_missing(&root, &bundle.entry_file, "")?;
    for path in &bundle.deletions {
        let target = root.join(path);
        if lstat(&target)?.is_some_and(|m| m.file_type().is_symlink()) {
            return Err(invalid("Instruction bundle target must not be a symlink"));
        }
        let _ = disk::remove_file(target);
    }
    Ok(root)
}

/// Create a managed directory one component at a time. `create_dir_all` can
/// follow a component replaced by a symlink between checks, so every existing
/// and newly created component is inspected before continuing.
fn ensure_owned_directory(base: &Path, target: &Path) -> io::Result<()> {
    let relative = target
        .strip_prefix(base)
        .map_err(|_| invalid("Instruction directory escaped its managed root"))?;
    let mut current = base.to_path_buf();
    if let Some(metadata) = lstat(&current)? {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid(
                "Instruction directory root must be an owned directory",
            ));
        }
        assert_owned(&current)?;
    } else {
        mkdir_private(&current)?;
        assert_owned(&current)?;
    }
    for component in relative.components() {
        current.push(component.as_os_str());
        match lstat(&current)? {
            Some(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(invalid("Instruction directory contains a symbolic link"));
            }
            Some(_) => assert_owned(&current)?,
            None => {
                mkdir_private(&current)?;
                assert_owned(&current)?;
            }
        }
    }
    Ok(())
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

fn bundle_location(
    host: &Host,
    row: &Value,
    home: &str,
    cwd: &str,
    root: &Path,
) -> io::Result<BundleLocation> {
    let org = text(row, "orgId");
    // Preserve the persisted workspace-key semantics used by AgentCore: a
    // missing key may be derived by the read helper, while an explicit blank
    // key fails closed instead of selecting a derived workspace.
    let workspace = if row["workspaceKey"].is_null() {
        super::reads::workspace_key(row)
    } else {
        js_trim(text(row, "workspaceKey")).to_owned()
    };
    if workspace.is_empty()
        || !workspace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(invalid("Invalid Agent workspace key"));
    }
    let agent_root = root.join("agents").join(&workspace);
    let managed = agent_root.join("instructions");
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
    Ok(BundleLocation {
        workspace,
        agent_root,
        managed,
        configured,
        entry,
        legacy_path,
        mode,
        legacy_managed,
    })
}

fn validated_workspace_key(row: &Value) -> io::Result<String> {
    let workspace = super::reads::workspace_key(row);
    if workspace.is_empty()
        || !workspace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(invalid("Invalid Agent workspace key"));
    }
    Ok(workspace)
}

fn recover(host: &Host, row: &Value, home: &str, cwd: &str) -> io::Result<Value> {
    let org = text(row, "orgId");
    // Validate all existing path components before storage::ensure can create,
    // migrate, or materialize anything.
    let workspace = validated_workspace_key(row)?;
    let (storage_root, _) = storage::root(host, org)?;
    validate_workspace_for_io(host, org, &storage_root, &workspace)?;
    let root = storage::ensure(host, org, Path::new(cwd))?;
    validate_workspace_for_io(host, org, &root, &workspace)?;
    let location = bundle_location(host, row, home, cwd, &root)?;
    for directory in ["instructions", "memory", "life", "skills"] {
        ensure_owned_directory(&root, &location.agent_root.join(directory))?;
    }
    let config = &row["agentRuntimeConfig"];
    if location.legacy_managed {
        if let Some(source) = &location.configured
            && stat(source).is_some_and(|m| m.is_dir())
        {
            preflight_root(source, false)?;
            for file in files(source)? {
                let body = disk::read(source.join(&file))?;
                write_missing(&location.managed, &file, &String::from_utf8_lossy(&body))?;
            }
        }
        let mut content = defaults(text(row, "role") == "ceo");
        let legacy_body = location
            .legacy_path
            .as_ref()
            .map(|path| {
                preflight_file(path)?;
                disk::read(path)
            })
            .transpose()?
            .map(|body| String::from_utf8_lossy(&body).into_owned())
            .or_else(|| string(config, "promptTemplate").map(str::to_owned))
            .unwrap_or_default();
        if !js_trim(&legacy_body).is_empty() {
            content.insert(location.entry.clone(), legacy_body);
        } else if !content.contains_key(&location.entry) {
            content.insert(
                location.entry.clone(),
                content.get("SOUL.md").cloned().unwrap_or_default(),
            );
        }
        for (file, body) in content {
            write_missing(&location.managed, &file, &body)?;
        }
        if !stat(&location.managed.join("MEMORY.md")).is_some_and(|m| m.is_file())
            && stat(&location.agent_root.join("MEMORY.md")).is_some_and(|m| m.is_file())
        {
            let memory = disk::read(location.agent_root.join("MEMORY.md"))?;
            write_missing(
                &location.managed,
                "MEMORY.md",
                &String::from_utf8_lossy(&memory),
            )?;
        }
    }
    let mut mode = if location.legacy_managed {
        Some("managed")
    } else {
        location.mode
    };
    if !files(&location.managed)?.is_empty()
        && (location.configured.is_none() || mode != Some("external"))
    {
        mode = Some("managed");
    }
    // getBundle stats all referenced summaries even though detail only returns
    // this mode-derived path. Preserve observable filesystem failures.
    if let Some(configured) = location.configured
        && mode == Some("external")
    {
        preflight_root(&configured, true)?;
        if configured.is_dir() {
            for file in files(&configured)? {
                disk::metadata(configured.join(file))?;
            }
        }
    }
    Ok(if mode == Some("managed") {
        json!(format!("agents/{}/instructions", location.workspace))
    } else {
        Value::Null
    })
}

pub(crate) struct RuntimeInstructionRevision {
    pub revision: String,
    pub source_path: Option<PathBuf>,
    /// The selected entry path relative to `source_path` when a bundle root
    /// exists. This is metadata only; the content is carried separately.
    pub entry_file: String,
    /// Bounded UTF-8 content the native supervisor may pass as instruction
    /// text. This intentionally has no `Debug` or serialization implementation.
    pub entry_content: Option<String>,
}

pub(crate) fn managed_agent_workspace_path(
    instance_root: &Path,
    workspace_home: &Path,
    previous_documents_root: &Path,
    friendly_workspace_home: bool,
    org: &str,
    row: &Value,
) -> io::Result<PathBuf> {
    let host = Host {
        instance_root: instance_root.to_string_lossy().into_owned(),
        workspace_home: workspace_home.to_string_lossy().into_owned(),
        previous_documents_root: previous_documents_root.to_string_lossy().into_owned(),
        friendly_workspace_home,
        hostname: "native-chat".to_owned(),
    };
    if text(row, "orgId") != org
        || [instance_root, workspace_home, previous_documents_root]
            .iter()
            .any(|path| !path.is_absolute())
    {
        return Err(invalid("Invalid Native Chat instruction host facts"));
    }
    let (root, _) = storage::root(&host, org)?;
    storage::validate_readonly(&host, org, &root)?;
    let workspace = validated_workspace_key(row)?;
    let workspace_root = root.join("agents").join(&workspace);
    storage::validate_readonly_path(&root, &workspace_root.join("instructions"))?;
    Ok(workspace_root)
}

/// Resolve effective instruction files without creating, migrating, or
/// rewriting the Agent workspace. The selected entry content is returned only
/// to the Rust supervisor; it has no `Debug` or serialization implementation.
/// All discovered bundle files contribute to the identity digest, but only the
/// configured entry is returned as content.
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_readonly_for_runtime(
    instance_root: &Path,
    workspace_home: &Path,
    previous_documents_root: &Path,
    friendly_workspace_home: bool,
    org: &str,
    row: &Value,
    home: &Path,
    cwd: &Path,
) -> io::Result<RuntimeInstructionRevision> {
    let host = Host {
        instance_root: instance_root.to_string_lossy().into_owned(),
        workspace_home: workspace_home.to_string_lossy().into_owned(),
        previous_documents_root: previous_documents_root.to_string_lossy().into_owned(),
        friendly_workspace_home,
        hostname: "native-chat".to_owned(),
    };
    if [
        instance_root,
        workspace_home,
        previous_documents_root,
        home,
        cwd,
    ]
    .iter()
    .any(|path| !path.is_absolute())
        || text(row, "orgId") != org
    {
        return Err(invalid("Invalid Native Chat instruction host facts"));
    }
    let (root, _) = storage::root(&host, org)?;
    storage::validate_readonly(&host, org, &root)?;
    validated_workspace_key(row)?;
    let location = bundle_location(
        &host,
        row,
        &home.to_string_lossy(),
        &cwd.to_string_lossy(),
        &root,
    )?;
    storage::validate_readonly_path(&root, &location.managed)?;
    let managed_files = read_only::file_count(&location.managed, true)?;
    let mode = if location.legacy_managed
        || (managed_files != 0
            && (location.configured.is_none() || location.mode != Some("external")))
    {
        Some("managed")
    } else {
        location.mode
    };

    let mut contents = BTreeMap::<String, Vec<u8>>::new();
    let source_path = match mode {
        Some("managed") => {
            read_only::read_bundle(&location.managed, true, &mut contents)?;
            if location.legacy_managed {
                if let Some(source) = &location.configured {
                    read_only::read_bundle(source, true, &mut contents)?;
                }
                for (name, body) in defaults(text(row, "role") == "ceo") {
                    contents.entry(name).or_insert_with(|| body.into_bytes());
                }
                let legacy_body = if contents.contains_key(&location.entry) {
                    None
                } else if let Some(path) = &location.legacy_path {
                    read_only::read_single(path, &contents)?
                } else {
                    None
                }
                .or_else(|| {
                    string(&row["agentRuntimeConfig"], "promptTemplate")
                        .map(|value| value.as_bytes().to_vec())
                })
                .unwrap_or_default();
                if !js_trim(&String::from_utf8_lossy(&legacy_body)).is_empty() {
                    read_only::insert_bounded(&mut contents, location.entry.clone(), legacy_body)?;
                } else if !contents.contains_key(&location.entry) {
                    let soul = contents.get("SOUL.md").cloned().unwrap_or_default();
                    contents.insert(location.entry.clone(), soul);
                }
            }
            Some(location.managed)
        }
        Some("external") => {
            let source = location
                .configured
                .as_ref()
                .or_else(|| {
                    location
                        .legacy_path
                        .as_ref()
                        .and_then(|path| path.parent().map(|_| path))
                })
                .map(|path| {
                    if path.is_file() {
                        path.parent().unwrap_or(path)
                    } else {
                        path.as_path()
                    }
                });
            if let Some(source) = source {
                read_only::read_bundle(source, false, &mut contents)?;
                Some(source.to_path_buf())
            } else {
                None
            }
        }
        _ => None,
    };

    let entry_content = if Path::new(&location.entry)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("HEARTBEAT.md"))
    {
        // The legacy TS loader explicitly ignores HEARTBEAT.md as an Agent
        // instruction entry. Keep that behavior without reading it as prompt.
        None
    } else if let Some(bytes) = contents.get(&location.entry) {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| invalid("Instruction entry is not valid UTF-8"))?;
        let effective = text.trim_end();
        (!effective.is_empty()).then(|| effective.to_owned())
    } else {
        None
    };

    let mut hasher = Sha256::new();
    hasher.update(b"rudder-agent-instructions-v1\0");
    hasher.update(mode.unwrap_or("none").as_bytes());
    hasher.update([0]);
    hasher.update(location.entry.as_bytes());
    hasher.update([0]);
    for (name, bytes) in contents {
        hasher.update((name.len() as u64).to_be_bytes());
        hasher.update(name.as_bytes());
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    let digest = hasher.finalize();
    let revision = format!(
        "sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    Ok(RuntimeInstructionRevision {
        revision,
        source_path,
        entry_file: location.entry,
        entry_content,
    })
}

fn default_path_key(runtime: &str) -> Option<&'static str> {
    match runtime {
        "claude_local" | "codex_local" | "opencode_local" | "cursor" | "pi_local" => {
            Some("instructionsFilePath")
        }
        _ => None,
    }
}

fn instruction_path_key(
    value: Option<&Value>,
    runtime: &str,
    allow_unknown_fallback: bool,
) -> Result<String> {
    let key = value
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| default_path_key(runtime).map(str::to_owned))
        .or_else(|| allow_unknown_fallback.then(|| "instructionsFilePath".to_owned()))
        .ok_or_else(|| {
            http(
                422,
                format!(
                    "No default instructions path key for adapter type '{runtime}'. Provide agentRuntimeConfigKey."
                ),
            )
        })?;
    Ok(key)
}

fn managed_root(host: &Host, org: &str, workspace: &str, cwd: &str) -> io::Result<PathBuf> {
    if workspace.is_empty()
        || !workspace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(invalid("Invalid Agent workspace key"));
    }
    let _ = cwd;
    let (storage_root, _) = storage::root(host, org)?;
    validate_workspace_for_io(host, org, &storage_root, workspace)?;
    Ok(storage_root
        .join("agents")
        .join(workspace)
        .join("instructions"))
}

fn summary(root: &Path, entry: &str) -> io::Result<Vec<Value>> {
    preflight_root(root, false)?;
    let mut output = Vec::new();
    for file in files(root)? {
        let stat = disk::metadata(root.join(&file))?;
        let lower = file.to_ascii_lowercase();
        output.push(json!({"path":file,"size":stat.len(),"language":infer_language(&file),"markdown":lower.ends_with(".md"),"isEntryFile":file==entry,"editable":true,"deprecated":false,"virtual":false}));
    }
    Ok(output)
}

fn summary_for_contents(files: &BTreeMap<String, String>, entry: &str) -> Vec<Value> {
    let mut output = files
        .iter()
        .map(|(path, body)| {
            let lower = path.to_ascii_lowercase();
            json!({
                "path": path,
                "size": body.len(),
                "language": infer_language(path),
                "markdown": lower.ends_with(".md"),
                "isEntryFile": path == entry,
                "editable": true,
                "deprecated": false,
                "virtual": false,
            })
        })
        .collect::<Vec<_>>();
    output.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    output
}

/// Keep file language labels compatible with the legacy Node service.  These
/// labels are part of the public bundle/file response and are intentionally
/// based on the normalized relative path rather than file contents.
fn infer_language(relative_path: &str) -> &'static str {
    let lower = relative_path.to_ascii_lowercase();
    if lower.ends_with(".md") {
        "markdown"
    } else if lower.ends_with(".json") {
        "json"
    } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        "yaml"
    } else if lower.ends_with(".ts") || lower.ends_with(".tsx") {
        "typescript"
    } else if lower.ends_with(".js")
        || lower.ends_with(".jsx")
        || lower.ends_with(".mjs")
        || lower.ends_with(".cjs")
    {
        "javascript"
    } else if lower.ends_with(".sh") {
        "bash"
    } else if lower.ends_with(".py") {
        "python"
    } else if lower.ends_with(".toml") {
        "toml"
    } else {
        "text"
    }
}

fn js_string_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn legacy_prompt_summary(config: &serde_json::Map<String, Value>, files: &mut Vec<Value>) {
    let Some(content) = config
        .get("promptTemplate")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if files
        .iter()
        .any(|file| file["path"] == "promptTemplate.legacy.md")
    {
        return;
    }
    files.push(json!({
        "path": "promptTemplate.legacy.md",
        "size": js_string_len(content),
        "language": "markdown",
        "markdown": true,
        "isEntryFile": false,
        "editable": true,
        "deprecated": true,
        "virtual": true,
    }));
    files.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
}

fn legacy_prompt_active(config: &serde_json::Map<String, Value>, key: &str) -> bool {
    config
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !js_trim(value).is_empty())
}

fn operation_path(
    ctx: &Context<'_>,
    row: &Value,
    input: &Value,
    allow_unknown_fallback: bool,
) -> Result<(String, PathBuf, String)> {
    let config = row["agentRuntimeConfig"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let key = instruction_path_key(
        input.get("agentRuntimeConfigKey"),
        text(row, "agentRuntimeType"),
        allow_unknown_fallback,
    )?;
    let path = config
        .get(&key)
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("")
        .to_owned();
    let host = ctx
        .request
        .instructions_host
        .as_ref()
        .ok_or_else(|| http(503, "Rust Agent instruction placement is unavailable"))?;
    let root = managed_root(
        host,
        ctx.org,
        text(row, "workspaceKey"),
        &ctx.request.process_working_directory,
    )
    .map_err(|e| http(422, e.to_string()))?;
    Ok((key, root, path))
}

/// Match the legacy Node adapter route's path.resolve semantics. Relative
/// values are accepted only when the adapter config carries an absolute cwd;
/// absolute values are normalized lexically so `..` and `.` behave like Node.
fn resolve_instructions_file_path(candidate: &str, config: &Value) -> Result<String> {
    let candidate = js_trim(candidate);
    if Path::new(candidate).is_absolute() {
        return Ok(path(candidate, Path::new("/"))
            .to_string_lossy()
            .into_owned());
    }
    let cwd = string(config, "cwd").ok_or_else(|| {
        http(
            422,
            "Relative instructions path requires agentRuntimeConfig.cwd to be set to an absolute path",
        )
    })?;
    if !Path::new(cwd).is_absolute() {
        return Err(http(
            422,
            "agentRuntimeConfig.cwd must be an absolute path to resolve relative instructions path",
        ));
    }
    Ok(path(candidate, Path::new(cwd))
        .to_string_lossy()
        .into_owned())
}

fn sync_bundle_config_from_file_path(
    ctx: &Context<'_>,
    row: &Value,
    config: &mut serde_json::Map<String, Value>,
) -> Result<()> {
    let Some(file_path) = config
        .get("instructionsFilePath")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|value| !value.is_empty())
    else {
        config.remove("instructionsBundleMode");
        config.remove("instructionsRootPath");
        config.remove("instructionsEntryFile");
        return Ok(());
    };
    let resolved = resolve_instructions_file_path(file_path, &Value::Object(config.clone()))?;
    let host = ctx
        .request
        .instructions_host
        .as_ref()
        .ok_or_else(|| http(503, "Rust Agent instruction placement is unavailable"))?;
    let managed_root = managed_root(
        host,
        ctx.org,
        text(row, "workspaceKey"),
        &ctx.request.process_working_directory,
    )
    .map_err(|error| http(422, error.to_string()))?;
    let resolved_path = Path::new(&resolved);
    let workspace = text(row, "workspaceKey");
    let historical_roots = [
        Path::new(&host.previous_documents_root)
            .join("agents")
            .join(workspace)
            .join("instructions"),
        Path::new(&host.instance_root)
            .join("organizations")
            .join(storage::key(ctx.org))
            .join("workspaces/agents")
            .join(workspace)
            .join("instructions"),
    ];
    let managed = if resolved_path.starts_with(&managed_root)
        || historical_roots
            .iter()
            .any(|root| resolved_path.starts_with(root))
    {
        "managed"
    } else {
        "external"
    };
    if managed == "external" {
        return Err(managed_only_error());
    }
    let parent = resolved_path
        .parent()
        .ok_or_else(|| http(422, "Invalid instructions path"))?;
    let entry = resolved_path
        .file_name()
        .ok_or_else(|| http(422, "Invalid instructions path"))?;
    config.insert("instructionsBundleMode".into(), json!(managed));
    config.insert(
        "instructionsRootPath".into(),
        json!(parent.to_string_lossy().into_owned()),
    );
    config.insert(
        "instructionsEntryFile".into(),
        json!(entry.to_string_lossy().into_owned()),
    );
    config.insert("instructionsFilePath".into(), json!(resolved));
    Ok(())
}

fn require_managed_bundle(config: &Value) -> Result<()> {
    if config["instructionsBundleMode"].as_str() == Some("external") {
        return Err(managed_only_error());
    }
    Ok(())
}

fn managed_only_error() -> AgentCoreError {
    http(
        503,
        "Rust Agent instruction authority only supports managed bundles",
    )
}

async fn require_manage(tx: &mut Tx<'_>, ctx: &Context<'_>, row: &Value) -> Result<()> {
    let Some(actor) = ctx.agent() else {
        return Ok(());
    };
    let id = text(row, "id");
    if actor == id
        || text(row, "role") == "ceo"
        || super::can_create(row)
        || super::has_grant(tx, ctx, "agents:create").await?
    {
        return Ok(());
    }
    Err(http(
        403,
        "Only the target agent, CEO, or agent creators can update instructions path",
    ))
}

pub(super) async fn read_operation(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    row: &Value,
    op: &str,
    input: &Value,
    native_auth: Option<&dyn super::NativeAgentAuthorizer>,
) -> Result<Value> {
    super::revalidate_native_auth(native_auth, tx, ctx.org).await?;
    if op == "instructions-path-get" {
        let (key, _, path) = operation_path(ctx, row, input, true)?;
        return Ok(
            json!({"agentId":text(row,"id"),"agentRuntimeType":text(row,"agentRuntimeType"),"agentRuntimeConfigKey":key,"path":if path.is_empty(){Value::Null}else{json!(path)}}),
        );
    }
    let _ = library_path(tx, ctx, row, native_auth).await?;
    // Recovery may persist managed bundle defaults or a repaired path. Read
    // the row again so the response reflects the durable state that was just
    // materialized rather than the pre-recovery snapshot.
    let row = super::stored(tx, text(row, "id"))
        .await?
        .ok_or_else(|| http(404, "Agent not found"))?;
    let host = ctx
        .request
        .instructions_host
        .as_ref()
        .ok_or_else(|| http(503, "Rust Agent instruction placement is unavailable"))?;
    let root = managed_root(
        host,
        ctx.org,
        text(&row, "workspaceKey"),
        &ctx.request.process_working_directory,
    )
    .map_err(|e| http(422, e.to_string()))?;
    let config = row["agentRuntimeConfig"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    require_managed_bundle(&Value::Object(config.clone()))?;
    let entry = config
        .get("instructionsEntryFile")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("SOUL.md")
        .to_owned();
    if op == "instructions-bundle-get" {
        let mode = config
            .get("instructionsBundleMode")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut files = summary(&root, &entry)
            .map_err(|_| http(404, "Agent instructions bundle is not configured"))?;
        legacy_prompt_summary(&config, &mut files);
        return Ok(
            json!({"agentId":text(&row,"id"),"orgId":ctx.org,"mode":mode,"rootPath":config.get("instructionsRootPath"),"managedRootPath":root.to_string_lossy(),"entryFile":entry,"resolvedEntryPath":root.join(&entry).to_string_lossy(),"editable":true,"warnings":[],"legacyPromptTemplateActive":legacy_prompt_active(&config,"promptTemplate"),"legacyBootstrapPromptTemplateActive":legacy_prompt_active(&config,"bootstrapPromptTemplate"),"files":files}),
        );
    }
    let path = ctx.request.query["path"]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| http(422, "Query parameter 'path' is required"))?;
    let path = bundle_path(path).map_err(|e| http(422, e.to_string()))?;
    if path == "promptTemplate.legacy.md" {
        let content = config
            .get("promptTemplate")
            .and_then(Value::as_str)
            .map(js_trim)
            .ok_or_else(|| http(404, "Instructions file not found"))?;
        return Ok(json!({
            "path": path,
            "size": js_string_len(content),
            "language": "markdown",
            "markdown": true,
            "isEntryFile": false,
            "editable": true,
            "deprecated": true,
            "virtual": true,
            "content": content,
        }));
    }
    preflight_root(&root, false).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            http(404, "Instructions file not found")
        } else {
            http(422, error.to_string())
        }
    })?;
    let absolute = root.join(&path);
    preflight_file(&absolute).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            http(404, "Instructions file not found")
        } else {
            http(422, error.to_string())
        }
    })?;
    let metadata = lstat(&absolute)
        .map_err(|_| http(404, "Instructions file not found"))?
        .ok_or_else(|| http(404, "Instructions file not found"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(http(404, "Instructions file not found"));
    }
    let content =
        disk::read_to_string(&absolute).map_err(|_| http(404, "Instructions file not found"))?;
    Ok(
        json!({"path":path,"size":metadata.len(),"language":infer_language(&path),"markdown":path.to_ascii_lowercase().ends_with(".md"),"isEntryFile":path==entry,"editable":true,"deprecated":false,"virtual":false,"content":content}),
    )
}

pub(super) async fn write_operation(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    row: &Value,
    op: &str,
    input: &Value,
    native_auth: Option<&dyn super::NativeAgentAuthorizer>,
) -> Result<Value> {
    super::revalidate_native_auth(native_auth, tx, ctx.org).await?;
    require_manage(tx, ctx, row).await?;
    let id = text(row, "id");
    let before = row["agentRuntimeConfig"].clone();
    let requested_file_path = if op == "instructions-file-put" {
        input["path"].as_str().unwrap_or("")
    } else if op == "instructions-file-delete" {
        ctx.request.query["path"].as_str().unwrap_or("")
    } else {
        ""
    };
    if matches!(op, "instructions-file-put" | "instructions-file-delete")
        && bundle_path(requested_file_path).is_ok_and(|path| path == "promptTemplate.legacy.md")
    {
        if op == "instructions-file-delete" {
            return Err(http(
                422,
                "Cannot delete the legacy promptTemplate pseudo-file",
            ));
        }
        let content = input["content"]
            .as_str()
            .ok_or_else(|| http(422, "Invalid instructions file content"))?;
        let exposed_content = js_trim(content);
        let mut config = before.as_object().cloned().unwrap_or_default();
        // The pseudo-file is a compatibility view over promptTemplate. The
        // Node route intentionally leaves clearLegacyPromptTemplate untouched
        // for this virtual write.
        config.insert("promptTemplate".into(), json!(content));
        let updated = super::update(
            tx,
            ctx.org,
            id,
            &json!({"agentRuntimeConfig":Value::Object(config.clone()),"updatedAt":now()}),
        )
        .await?;
        super::insert(tx,"agent_config_revisions",&json!({"orgId":ctx.org,"agentId":id,"createdByAgentId":ctx.agent(),"createdByUserId":ctx.user(),"source":"instructions_bundle_file_put","changedKeys":["agentRuntimeConfig"],"beforeConfig":super::redaction::config(&before),"afterConfig":super::redaction::config(&Value::Object(config))})).await?;
        activity(
            tx,
            ctx,
            "agent.instructions_file_updated",
            id,
            Some(&json!({"path":"promptTemplate.legacy.md","size":js_string_len(exposed_content)})),
        )
        .await?;
        return Ok(json!({
            "path": "promptTemplate.legacy.md",
            "size": js_string_len(exposed_content),
            "language": "markdown",
            "markdown": true,
            "isEntryFile": false,
            "editable": true,
            "deprecated": true,
            "virtual": true,
            "content": exposed_content,
            "agentRuntimeConfig": updated["agentRuntimeConfig"],
        }));
    }
    if op == "instructions-path-patch" {
        if before["instructionsBundleMode"].as_str() == Some("external") {
            // The Rust slice has no descriptor-relative external-root writer.
            // Reject even a clear operation so this compatibility field cannot
            // mutate or implicitly convert an external bundle.
            return Err(managed_only_error());
        }
        let (key, _, _) = operation_path(ctx, row, input, false)?;
        let mut config = before.as_object().cloned().unwrap_or_default();
        match input.get("path") {
            Some(Value::Null) => {
                config.remove(&key);
            }
            Some(Value::String(path)) => {
                let resolved =
                    resolve_instructions_file_path(path, &Value::Object(config.clone()))?;
                config.insert(key.clone(), json!(resolved));
            }
            _ => return Err(http(422, "Invalid instructions path")),
        }
        // The legacy route keeps the adapter's path key and synchronizes the
        // bundle compatibility fields from the canonical instructions path.
        // This also preserves the external-mode contract for absolute paths.
        sync_bundle_config_from_file_path(ctx, row, &mut config)?;
        let updated = super::update(
            tx,
            ctx.org,
            id,
            &json!({"agentRuntimeConfig":Value::Object(config.clone()),"updatedAt":now()}),
        )
        .await?;
        super::insert(tx,"agent_config_revisions",&json!({"orgId":ctx.org,"agentId":id,"createdByAgentId":ctx.agent(),"createdByUserId":ctx.user(),"source":"instructions_path_patch","changedKeys":["agentRuntimeConfig"],"beforeConfig":super::redaction::config(&before),"afterConfig":super::redaction::config(&Value::Object(config.clone()))})).await?;
        activity(tx,ctx,"agent.instructions_path_updated",id,Some(&json!({"agentRuntimeConfigKey":key,"path":config.get(&key),"cleared":input["path"].is_null()}))).await?;
        return Ok(
            json!({"agentId":id,"agentRuntimeType":text(&updated,"agentRuntimeType"),"agentRuntimeConfigKey":key,"path":config.get(&key)}),
        );
    }
    if op == "instructions-bundle-patch" {
        let mut config = before.as_object().cloned().unwrap_or_default();
        let requested_mode = input.get("mode").and_then(Value::as_str);
        let current_mode = before["instructionsBundleMode"]
            .as_str()
            .unwrap_or("managed");
        // Preserve the existing external-mode boundary when the legacy
        // request omits mode. Do not silently convert an external bundle to
        // managed authority just because this Rust slice has no external
        // filesystem owner.
        if requested_mode.is_none() && current_mode == "external" {
            return Err(managed_only_error());
        }
        let mode = requested_mode.unwrap_or(current_mode);
        // External bundles remain a deliberate compatibility boundary. The
        // Rust authority exposes managed bundle materialization only; callers
        // receive a stable 503 until an external-root owner is available.
        if mode == "external" {
            return Err(managed_only_error());
        }
        let host = ctx
            .request
            .instructions_host
            .as_ref()
            .ok_or_else(|| http(503, "Rust Agent instruction placement is unavailable"))?;
        let root = managed_root(
            host,
            ctx.org,
            text(row, "workspaceKey"),
            &ctx.request.process_working_directory,
        )
        .map_err(|e| http(422, e.to_string()))?;
        preflight_root(&root, true).map_err(|error| http(422, error.to_string()))?;
        config.insert("instructionsBundleMode".into(), json!(mode));
        config.insert("instructionsRootPath".into(), json!(root.to_string_lossy()));
        let entry_file = input
            .get("entryFile")
            .and_then(Value::as_str)
            .unwrap_or("SOUL.md");
        let entry_file = bundle_path(entry_file).map_err(|error| http(422, error.to_string()))?;
        config.insert("instructionsEntryFile".into(), json!(entry_file));
        config.insert(
            "instructionsFilePath".into(),
            json!(
                root.join(
                    config["instructionsEntryFile"]
                        .as_str()
                        .unwrap_or("SOUL.md")
                )
                .to_string_lossy()
            ),
        );
        if input
            .get("clearLegacyPromptTemplate")
            .and_then(Value::as_bool)
            == Some(true)
        {
            config.remove("promptTemplate");
            config.remove("bootstrapPromptTemplate");
        }
        let entry = config["instructionsEntryFile"]
            .as_str()
            .unwrap_or("SOUL.md")
            .to_owned();
        let mut bundle_files = serde_json::Map::new();
        if root.is_dir() {
            for file in files(&root).map_err(|_| http(500, "Internal server error"))? {
                if let Ok(body) = disk::read_to_string(root.join(&file)) {
                    bundle_files.insert(file, json!(body));
                }
            }
        }
        if bundle_files.is_empty() {
            bundle_files.insert(entry.clone(), json!(""));
        }
        let response_contents = bundle_files
            .iter()
            .filter_map(|(path, body)| body.as_str().map(|body| (path.clone(), body.to_owned())))
            .collect::<BTreeMap<_, _>>();
        let mut response_files = summary_for_contents(&response_contents, &entry);
        legacy_prompt_summary(&config, &mut response_files);
        bundle_files.insert("__rudderReplace".into(), json!(true));
        sqlx::query("INSERT INTO agent_instruction_bundles (agent_id,org_id,entry_file,files,clear_legacy_prompt_template,state,attempts,next_attempt_at) VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5,'pending',0,now()) ON CONFLICT(agent_id) DO UPDATE SET org_id=excluded.org_id,entry_file=excluded.entry_file,files=excluded.files,clear_legacy_prompt_template=excluded.clear_legacy_prompt_template,state='pending',attempts=0,next_attempt_at=now(),last_error=NULL,materialized_at=NULL,updated_at=now()")
            .bind(id).bind(ctx.org).bind(&entry).bind(Value::Object(bundle_files).to_string()).bind(input.get("clearLegacyPromptTemplate").and_then(Value::as_bool).unwrap_or(false)).execute(&mut **tx).await?;
        let _updated = super::update(
            tx,
            ctx.org,
            id,
            &json!({"agentRuntimeConfig":Value::Object(config.clone()),"updatedAt":now()}),
        )
        .await?;
        super::insert(tx,"agent_config_revisions",&json!({"orgId":ctx.org,"agentId":id,"createdByAgentId":ctx.agent(),"createdByUserId":ctx.user(),"source":"instructions_bundle_patch","changedKeys":["agentRuntimeConfig"],"beforeConfig":super::redaction::config(&before),"afterConfig":super::redaction::config(&Value::Object(config.clone()))})).await?;
        activity(
            tx,
            ctx,
            "agent.instructions_bundle_updated",
            id,
            Some(&json!({"mode":mode,"rootPath":root})),
        )
        .await?;
        return Ok(
            json!({"agentId":id,"orgId":ctx.org,"mode":mode,"rootPath":root,"managedRootPath":root,"entryFile":config["instructionsEntryFile"],"resolvedEntryPath":root.join(config["instructionsEntryFile"].as_str().unwrap_or("SOUL.md")),"editable":true,"warnings":[],"legacyPromptTemplateActive":legacy_prompt_active(&config,"promptTemplate"),"legacyBootstrapPromptTemplateActive":legacy_prompt_active(&config,"bootstrapPromptTemplate"),"files":response_files}),
        );
    }
    let host = ctx
        .request
        .instructions_host
        .as_ref()
        .ok_or_else(|| http(503, "Rust Agent instruction placement is unavailable"))?;
    let root = managed_root(
        host,
        ctx.org,
        text(row, "workspaceKey"),
        &ctx.request.process_working_directory,
    )
    .map_err(|e| http(422, e.to_string()))?;
    preflight_root(&root, true).map_err(|error| http(422, error.to_string()))?;
    require_managed_bundle(&before)?;
    let mut entry = before
        .get("instructionsEntryFile")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .unwrap_or("SOUL.md")
        .to_owned();
    let path = if op == "instructions-file-put" {
        input["path"].as_str().unwrap_or("")
    } else {
        ctx.request.query["path"].as_str().unwrap_or("")
    };
    let path = bundle_path(path).map_err(|e| http(422, e.to_string()))?;
    if op == "instructions-file-delete" && path == entry {
        return Err(http(422, "Cannot delete the bundle entry file"));
    }
    // Serialize writes against any existing durable snapshot. The materialized
    // tree may reflect only part of a previous attempt, so using it as the
    // next desired state would lose edits that are still pending or repairing.
    let pending = sqlx::query_as::<_, (String, String, bool)>(
        "SELECT entry_file,files::text,clear_legacy_prompt_template
           FROM agent_instruction_bundles
          WHERE org_id=$1::uuid AND agent_id=$2::uuid
            AND state IN ('pending','repair')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE",
    )
    .bind(ctx.org)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    let mut clear_legacy_prompt_template = input
        .get("clearLegacyPromptTemplate")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut desired = BTreeMap::<String, String>::new();
    if let Some((pending_entry, pending_files, pending_clear)) = pending {
        let pending_bundle =
            decode_durable_bundle(&pending_entry, &pending_files, pending_clear)
                .map_err(|_| http(503, "Agent instructions bundle repair is pending"))?;
        entry = pending_bundle.entry_file;
        desired = pending_bundle.files;
        clear_legacy_prompt_template |= pending_clear;
        for path in pending_bundle.deletions {
            desired.remove(&path);
        }
    } else if root.is_dir() {
        for file in files(&root).map_err(|_| http(500, "Internal server error"))? {
            if let Ok(body) = disk::read_to_string(root.join(&file)) {
                desired.insert(file, body);
            }
        }
    }
    let mut delete_marker = Vec::<String>::new();
    if op == "instructions-file-put" {
        let content = input["content"]
            .as_str()
            .ok_or_else(|| http(422, "Invalid instructions file content"))?;
        desired.insert(path.clone(), content.to_owned());
    } else {
        desired.remove(&path);
        delete_marker.push(path.clone());
    }
    let response_contents = desired.clone();
    let mut files_json = serde_json::Map::new();
    for (name, body) in desired {
        files_json.insert(name, json!(body));
    }
    files_json.insert("__rudderReplace".into(), json!(true));
    if !delete_marker.is_empty() {
        files_json.insert("__rudderDeletes".into(), json!(delete_marker));
    }
    let files_value = Value::Object(files_json);
    sqlx::query("INSERT INTO agent_instruction_bundles (agent_id,org_id,entry_file,files,clear_legacy_prompt_template,state,attempts,next_attempt_at) VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5,'pending',0,now()) ON CONFLICT(agent_id) DO UPDATE SET org_id=excluded.org_id,entry_file=excluded.entry_file,files=excluded.files,clear_legacy_prompt_template=excluded.clear_legacy_prompt_template,state='pending',attempts=0,next_attempt_at=now(),last_error=NULL,materialized_at=NULL,updated_at=now()")
        .bind(id).bind(ctx.org).bind(&entry).bind(files_value.to_string()).bind(clear_legacy_prompt_template).execute(&mut **tx).await?;
    let mut config = before.as_object().cloned().unwrap_or_default();
    config.insert("instructionsBundleMode".into(), json!("managed"));
    config.insert("instructionsRootPath".into(), json!(root.to_string_lossy()));
    config.insert("instructionsEntryFile".into(), json!(entry));
    config.insert(
        "instructionsFilePath".into(),
        json!(
            root.join(
                config["instructionsEntryFile"]
                    .as_str()
                    .unwrap_or("SOUL.md")
            )
            .to_string_lossy()
        ),
    );
    if input
        .get("clearLegacyPromptTemplate")
        .and_then(Value::as_bool)
        == Some(true)
    {
        config.remove("promptTemplate");
        config.remove("bootstrapPromptTemplate");
    }
    let mut response_files = summary_for_contents(&response_contents, &entry);
    legacy_prompt_summary(&config, &mut response_files);
    let updated = super::update(
        tx,
        ctx.org,
        id,
        &json!({"agentRuntimeConfig":Value::Object(config.clone()),"updatedAt":now()}),
    )
    .await?;
    super::insert(tx,"agent_config_revisions",&json!({"orgId":ctx.org,"agentId":id,"createdByAgentId":ctx.agent(),"createdByUserId":ctx.user(),"source":if op=="instructions-file-put" {"instructions_bundle_file_put"} else {"instructions_bundle_file_delete"},"changedKeys":["agentRuntimeConfig"],"beforeConfig":super::redaction::config(&before),"afterConfig":super::redaction::config(&Value::Object(config.clone()))})).await?;
    activity(
        tx,
        ctx,
        if op == "instructions-file-put" {
            "agent.instructions_file_updated"
        } else {
            "agent.instructions_file_deleted"
        },
        id,
        Some(&json!({"path":path,"size":input["content"].as_str().map(str::len).unwrap_or(0)})),
    )
    .await?;
    if op == "instructions-file-put" {
        let content = input["content"].as_str().unwrap_or("");
        return Ok(
            json!({"path":path,"size":content.len(),"language":infer_language(&path),"markdown":path.to_ascii_lowercase().ends_with(".md"),"isEntryFile":path==entry,"editable":true,"deprecated":false,"virtual":false,"content":content,"agentRuntimeConfig":updated["agentRuntimeConfig"]}),
        );
    }
    Ok(
        json!({"agentId":id,"orgId":ctx.org,"mode":"managed","rootPath":root,"managedRootPath":root,"entryFile":entry,"resolvedEntryPath":root.join(&entry),"editable":true,"warnings":[],"legacyPromptTemplateActive":legacy_prompt_active(&config,"promptTemplate"),"legacyBootstrapPromptTemplateActive":legacy_prompt_active(&config,"bootstrapPromptTemplate"),"files":response_files}),
    )
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
    // Do not let the read reconciler traverse an external root. The public
    // Rust slice is intentionally managed-only until an external-root owner
    // and its descriptor-relative security contract are implemented.
    let (storage_root, _) =
        storage::root(&host, ctx.org).map_err(|error| http(422, error.to_string()))?;
    let location = bundle_location(
        &host,
        row,
        &ctx.request.home_directory,
        &ctx.request.process_working_directory,
        &storage_root,
    )
    .map_err(|error| http(422, error.to_string()))?;
    if location.mode == Some("external") {
        return Err(managed_only_error());
    }
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
    let admin = ctx.user().is_some()
        && sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')",
        )
        .bind(ctx.user())
        .fetch_one(&mut **tx)
        .await?;
    let fresh = Context { admin, ..*ctx };
    authorize_org(tx, &fresh).await?;

    // The row is the durable source of truth for a private create bundle. A
    // detail read is the current authorized reconciliation trigger; filesystem
    // work remains outside the SQL transaction and is committed only after the
    // actor is revalidated.
    let pending = sqlx::query_as::<_, (String, String, bool)>(
        "SELECT entry_file,files::text,clear_legacy_prompt_template
           FROM agent_instruction_bundles
          WHERE org_id=$1::uuid AND agent_id=$2::uuid
            AND EXISTS (SELECT 1 FROM agents a WHERE a.id=agent_instruction_bundles.agent_id AND a.org_id=$1::uuid)
            AND state IN ('pending','repair')
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE",
    )
    .bind(ctx.org)
    .bind(text(row, "id"))
    .fetch_optional(&mut **tx)
    .await?;
    let has_pending = pending.is_some();
    let agent_id = text(row, "id").to_owned();
    let org = ctx.org.to_owned();
    let row = row.clone();
    let home = ctx.request.home_directory.clone();
    let cwd = ctx.request.process_working_directory.clone();
    let pending_for_materializer = pending.clone();
    let materialized = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let (materialize_error, materialized_root) = pending_for_materializer
            .as_ref()
            .map(|(entry_file, files, clear_legacy)| {
                match decode_durable_bundle(entry_file, files, *clear_legacy) {
                    Ok(bundle) => {
                        let workspace = if row["workspaceKey"].is_null() {
                            super::reads::workspace_key(&row)
                        } else {
                            js_trim(text(&row, "workspaceKey")).to_owned()
                        };
                        match materialize_bundle_locked(
                            &host,
                            &org,
                            &workspace,
                            &bundle,
                            Path::new(&cwd),
                        ) {
                            Ok(root) => (None, Some(root)),
                            Err(error) => (Some(error.to_string()), None),
                        }
                    }
                    Err(error) => (Some(error.to_string()), None),
                }
            })
            .unwrap_or((None, None));
        // Do not let a failed or malformed private bundle trigger legacy
        // default recovery writes. The durable row remains repairable and the
        // next authorized detail request can retry it after the cause is fixed.
        let recovered = if materialize_error.is_some() {
            Ok(Value::Null)
        } else {
            recover(&host, &row, &home, &cwd)
        };
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
            // The filesystem operation is an authorization boundary even
            // when it fails. Only the actor that started the request may
            // commit the retry state; otherwise leave the pending row intact.
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
            // Serialize the durable filesystem projection with concurrent
            // agent-runtime-config writers (for example instructions-path
            // PATCH) so replay cannot overwrite a newer config snapshot.
            let agent_exists = sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
            )
            .bind(ctx.org)
            .bind(&agent_id)
            .fetch_optional(&mut **tx)
            .await?;
            if agent_exists.is_none() {
                return Err(http(404, "Agent not found"));
            }
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

pub(super) async fn replay_after_commit(
    pool: &sqlx::PgPool,
    actor: &rudder_auth_core::VerifiedActor,
    request: &super::AgentCoreRequest,
    org: &str,
    agent_id: &str,
    native_auth: Option<&dyn super::NativeAgentAuthorizer>,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let admin = actor.actor().kind == "user" && sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(&actor.actor().id).fetch_one(&mut *tx).await?;
    let ctx = Context {
        org,
        actor,
        request,
        admin,
    };
    let row = super::stored(&mut tx, agent_id)
        .await?
        .ok_or_else(|| http(404, "Agent not found"))?;
    super::authorize_org(&mut tx, &ctx).await?;
    if let Err(error) = library_path(&mut tx, &ctx, &row, native_auth).await {
        let _ = sqlx::query("UPDATE agent_instruction_bundles SET state='repair',attempts=attempts+1,next_attempt_at=now(),last_error=$3,updated_at=now() WHERE org_id=$1::uuid AND agent_id=$2::uuid AND state='pending'").bind(org).bind(agent_id).bind(error.to_string()).execute(&mut *tx).await;
        tx.commit().await?;
        return Err(error);
    }
    tx.commit().await?;
    Ok(())
}
