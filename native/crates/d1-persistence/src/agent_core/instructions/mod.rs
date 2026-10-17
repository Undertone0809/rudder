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

/// Files created by the private AgentCreate preparation step. The SQL
/// transaction can call `compensate_create_bundle` if a later mutation fails;
/// pre-existing files are never removed.
#[derive(Debug)]
pub(super) struct MaterializedCreateBundle {
    root: PathBuf,
    created_files: Vec<PathBuf>,
}

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
    if !host_paths_are_absolute(host, Path::new(&ctx.request.process_working_directory))
        || !Path::new(&ctx.request.home_directory).is_absolute()
    {
        return Err(http(400, "Invalid Agent instruction host facts"));
    }
    Ok(())
}
fn host_paths_are_absolute(host: &Host, cwd: &Path) -> bool {
    !host.hostname.is_empty()
        && [
            &host.instance_root,
            &host.workspace_home,
            &host.previous_documents_root,
        ]
        .iter()
        .all(|path| Path::new(path).is_absolute())
        && cwd.is_absolute()
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
    if stat(&target).is_some_and(|m| m.is_file()) {
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or_else(|| invalid("Missing file parent"))?;
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

pub(super) fn materialize_create_bundle(
    host: &Host,
    org: &str,
    workspace_key: &str,
    bundle: &AgentCreateInstructionsBundle,
    cwd: &Path,
) -> io::Result<MaterializedCreateBundle> {
    if !host_paths_are_absolute(host, cwd) {
        return Err(invalid("Invalid Agent instruction host facts"));
    }
    let _guard = lock::Guard::acquire(Path::new(&host.workspace_home), &host.hostname)
        .map_err(|_| invalid("Instruction workspace lock unavailable"))?;
    let workspace = storage::ensure(host, org, cwd)?
        .join("agents")
        .join(workspace_key);
    let root = workspace.join("instructions");
    disk::create_dir_all(&root)?;
    let mut created_files = Vec::new();
    let result = (|| {
        for (relative_path, body) in &bundle.files {
            let normalized = relative(relative_path)?;
            let target = root.join(&normalized);
            if stat(&target).is_some_and(|metadata| metadata.is_file()) {
                continue;
            }
            write_missing(&root, &normalized, body)?;
            if stat(&target).is_some_and(|metadata| metadata.is_file()) {
                created_files.push(target);
            }
        }
        let entry = relative(&bundle.entry_file)?;
        let entry_path = root.join(entry);
        if !stat(&entry_path).is_some_and(|metadata| metadata.is_file()) {
            write_missing(&root, &bundle.entry_file, "")?;
            if stat(&entry_path).is_some_and(|metadata| metadata.is_file()) {
                created_files.push(entry_path);
            }
        }
        Ok(MaterializedCreateBundle {
            root: root.clone(),
            created_files: created_files.clone(),
        })
    })();
    match result {
        Ok(bundle) => Ok(bundle),
        Err(error) => {
            let cleanup = MaterializedCreateBundle {
                root,
                created_files,
            };
            let _ = compensate_create_bundle(cleanup);
            Err(error)
        }
    }
}

pub(super) fn compensate_create_bundle(bundle: MaterializedCreateBundle) -> io::Result<()> {
    let mut first_error = None;
    for path in bundle.created_files.iter().rev() {
        match disk::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    // Only remove empty directories under the bundle root; the workspace and
    // organization roots may predate this create attempt.
    for path in &bundle.created_files {
        let mut current = path.parent().map(Path::to_path_buf);
        while let Some(directory) = current {
            if !directory.starts_with(&bundle.root) {
                break;
            }
            match disk::remove_dir(&directory) {
                Ok(()) => current = directory.parent().map(Path::to_path_buf),
                Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => break,
                Err(error) => {
                    first_error.get_or_insert(error);
                    break;
                }
            }
        }
    }
    first_error.map_or(Ok(()), Err)
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
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        recover(&host, &row, &home, &cwd)
    })
    .await
    .map_err(|_| http(500, "Internal server error"))?
    .map_err(|_| http(500, "Internal server error"))
}
