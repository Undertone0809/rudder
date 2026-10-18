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
use super::{AgentCreateInstructionsBundle, common::*};
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

/// Shared, pure path and legacy-mode resolution. Both mutating Agent recovery
/// and Native Chat's read-only identity resolver use this exact decision logic.
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
    let root = storage::ensure(host, org, Path::new(cwd))?;
    // Preserve the legacy mutating resolver's workspace-key validation after
    // factoring shared path selection into `bundle_location`.
    validated_workspace_key(row)?;
    let location = bundle_location(host, row, home, cwd, &root)?;
    for directory in ["instructions", "memory", "life", "skills"] {
        disk::create_dir_all(location.agent_root.join(directory))?;
    }
    let config = &row["agentRuntimeConfig"];
    if location.legacy_managed {
        if let Some(source) = &location.configured
            && stat(source).is_some_and(|m| m.is_dir())
        {
            for file in files(source)? {
                let body = disk::read(source.join(&file))?;
                write_missing(&location.managed, &file, &String::from_utf8_lossy(&body))?;
            }
        }
        let mut content = defaults(text(row, "role") == "ceo");
        let legacy_body = location
            .legacy_path
            .as_ref()
            .and_then(|path| disk::read(path).ok())
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
        for file in files(&configured)? {
            disk::metadata(configured.join(file))?;
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
    Ok(root.join("agents").join(workspace))
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
    // lock. Revalidate before recover() performs host writes.
    super::revalidate_native_auth(native_auth, tx, ctx.org).await?;
    // A filesystem lock wait is also an authorization boundary. A revoked key,
    // membership or administrator role cannot use pre-wait authority.
    let admin=ctx.user().is_some() && sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(ctx.user()).fetch_one(&mut **tx).await?;
    let fresh = Context { admin, ..*ctx };
    authorize_org(tx, &fresh).await?;
    let row = row.clone();
    let home = ctx.request.home_directory.clone();
    let cwd = ctx.request.process_working_directory.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        recover(&host, &row, &home, &cwd)
    })
    .await
    .map_err(|_| http(500, "Internal server error"))?
    .map_err(|_| http(500, "Internal server error"))
}

#[cfg(test)]
fn materialize_bundle_for_test(
    host: &Host,
    org: &str,
    agent_key: &str,
    bundle: &AgentCreateInstructionsBundle,
    _root: &Path,
) -> io::Result<()> {
    if host.workspace_home.is_empty() || !Path::new(&host.workspace_home).is_absolute() {
        return Err(invalid("Invalid Agent instruction host facts"));
    }
    if agent_key.is_empty() || agent_key.contains('/') || agent_key.contains('\\') {
        return Err(invalid("Invalid Agent workspace key"));
    }
    let (workspace, _) = storage::root(host, org)?;
    let mut current = workspace.clone();
    if lstat(&current)?.is_none() {
        mkdir_private(&current)?;
    }
    for component in ["agents", agent_key, "instructions"] {
        current.push(component);
        match lstat(&current)? {
            Some(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(invalid("Instruction bundle root is not an owned directory"));
            }
            Some(_) => {}
            None => {
                mkdir_private(&current)?;
                assert_owned(&current)?;
            }
        }
    }
    let bundle =
        durable_bundle(bundle).map_err(|error| io::Error::new(error.kind(), error.to_string()))?;
    for (path, body) in bundle.files {
        write_missing(&current, &path, &body)?;
    }
    Ok(())
}
