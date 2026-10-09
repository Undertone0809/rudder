use super::{Host, fs::*};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};
const IDENTITY: &str = ".rudder-workspace.json";
const MIGRATIONS: &str = ".rudder-workspace-migrations.json";
pub(super) fn key(org: &str) -> String {
    if super::super::common::uuid_like(org) {
        org.replace('-', "")
            .chars()
            .take(12)
            .collect::<String>()
            .to_ascii_lowercase()
    } else {
        org.to_owned()
    }
}
fn same_identity(root: &Path, org: &str) -> bool {
    json(&root.join(IDENTITY)).is_ok_and(|v| v["orgId"] == org)
}
/// Admission is read-only: a known foreign owner must fail before any layout
/// or migration write. Missing and corrupt identities retain legacy recovery.
fn check_identity(root: &Path, org: &str) -> io::Result<()> {
    let file = root.join(IDENTITY);
    match json(&file) {
        Ok(value) if value["orgId"] == org => Ok(()),
        Ok(_) => Err(invalid("Organization workspace identity mismatch")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_)
            if fs::read(&file)
                .is_ok_and(|bytes| serde_json::from_slice::<Value>(&bytes).is_err()) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}
fn ensure_identity(root: &Path, org: &str) -> io::Result<()> {
    let file = root.join(IDENTITY);
    match json(&file) {
        Ok(value) if value["orgId"] == org => return Ok(()),
        Ok(_) => return Err(invalid("Organization workspace identity mismatch")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(_)
            if fs::read(&file)
                .is_ok_and(|bytes| serde_json::from_slice::<Value>(&bytes).is_err()) =>
        {
            fs::rename(
                &file,
                root.join(format!("{IDENTITY}.corrupt-{}", random()?)),
            )?;
            sync_dir(root)?;
        }
        Err(error) => return Err(error),
    }
    atomic_json(&file, &json!({"version":1,"orgId":org}))
}
fn aliases(root: &Path) -> io::Result<BTreeSet<String>> {
    match json(&root.join(MIGRATIONS)) {
        Ok(value) if value["version"] == 1 && value["compatibilityAliases"].is_array() => Ok(value
            ["compatibilityAliases"]
            .as_array()
            .expect("array")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()),
        Ok(_) => Err(invalid("Invalid organization workspace migration state")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(error),
    }
}
fn save_aliases(root: &Path, aliases: BTreeSet<String>, cwd: &Path) -> io::Result<()> {
    let aliases = aliases
        .into_iter()
        .map(|alias| path(&alias, cwd).to_string_lossy().to_string())
        .collect::<BTreeSet<_>>();
    atomic_json(
        &root.join(MIGRATIONS),
        &json!({"version":1,"compatibilityAliases":aliases}),
    )
}
fn valid_folder(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && ![
            ".rudder-organizations.json",
            ".rudder-organizations.lock",
            ".rudder-migration-backups",
            "organizations",
            "projects",
            ".rudder",
            "backups",
            "data",
            "instances",
            "runtimes",
        ]
        .contains(&value.to_ascii_lowercase().as_str())
}
pub(super) fn root(host: &Host, org: &str) -> io::Result<(PathBuf, bool)> {
    let home = Path::new(&host.workspace_home);
    if !host.friendly_workspace_home {
        return Ok((home.join(key(org)).join("workspaces"), false));
    }
    let map = match json(&home.join(".rudder-organizations.json")) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            json!({"version":1,"organizations":[]})
        }
        Err(error) => return Err(error),
    };
    let records = map["organizations"]
        .as_array()
        .filter(|_| map["version"] == 1)
        .ok_or_else(|| invalid("Invalid organization workspace mapping file"))?;
    if records.iter().any(|record| {
        ![
            "instanceId",
            "orgId",
            "folderName",
            "createdAt",
            "updatedAt",
        ]
        .iter()
        .all(|field| record[field].is_string())
    }) {
        return Err(invalid("Invalid organization workspace mapping file"));
    }
    let instance = Path::new(&host.instance_root)
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| invalid("Invalid instance root"))?;
    if let Some(record) = records
        .iter()
        .find(|record| record["instanceId"] == instance && record["orgId"] == org)
    {
        let folder = record["folderName"].as_str().expect("validated record");
        if !valid_folder(folder) {
            return Err(invalid("Invalid organization workspace folder mapping"));
        }
        return Ok((home.join(folder), true));
    }
    Ok((home.join(key(org)), false))
}
/// Called only while holding the shared workspace-map lock and current Agent
/// transaction locks. No background effect or unvalidated path selects a scope.
pub(super) fn ensure(host: &Host, org: &str, cwd: &Path) -> io::Result<PathBuf> {
    let instance = Path::new(&host.instance_root);
    let canonical_storage = instance.join("organizations").join(key(org));
    let legacy_storage = instance.join("organizations").join(org);
    let (canonical, mapped) = root(host, org)?;
    assert_owned(&canonical)?;
    for workspace in [
        &canonical,
        &canonical_storage.join("workspaces"),
        &legacy_storage.join("workspaces"),
        Path::new(&host.previous_documents_root),
    ] {
        check_identity(workspace, org)?;
    }
    if canonical_storage != legacy_storage && stat(&legacy_storage).is_some_and(|m| m.is_dir()) {
        if stat(&canonical_storage).is_some_and(|m| m.is_dir()) {
            preflight(&legacy_storage, &canonical_storage)?;
            if merge(&legacy_storage, &canonical_storage)? {
                archive(
                    &legacy_storage,
                    legacy_storage.parent().expect("storage parent"),
                )?;
            } else {
                fs::remove_dir(&legacy_storage)?;
            }
        } else {
            fs::create_dir_all(canonical_storage.parent().expect("storage parent"))?;
            fs::rename(&legacy_storage, &canonical_storage)?;
        }
    }
    let legacy = canonical_storage.join("workspaces");
    let previous = PathBuf::from(&host.previous_documents_root);
    let mut candidates = Vec::new();
    for candidate in [previous, legacy] {
        if candidate != canonical && !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    let mut migrated = false;
    for source in candidates {
        if !stat(&source).is_some_and(|m| m.is_dir()) {
            if stat(&canonical).is_some_and(|m| m.is_dir())
                && same_identity(&canonical, org)
                && aliases(&canonical)
                    .is_ok_and(|aliases| aliases.contains(&source.to_string_lossy().to_string()))
            {
                fs::create_dir_all(source.parent().expect("legacy parent"))?;
                alias(&source, &canonical)?;
                migrated = true;
            }
            continue;
        }
        if same_directory(&source, &canonical) {
            continue;
        }
        if stat(&canonical).is_some_and(|m| m.is_dir()) {
            assert_atomic(&source, &canonical)?;
            ensure_identity(&canonical, org)?;
            ensure_identity(&source, org)?;
            let mut all = aliases(&canonical)?;
            all.extend(aliases(&source)?);
            all.insert(source.to_string_lossy().to_string());
            save_aliases(&source, all, cwd)?;
            preflight(&canonical, &source)?;
            if merge(&canonical, &source)? {
                archive(&canonical, source.parent().expect("legacy parent"))?;
            } else {
                fs::remove_dir(&canonical)?;
            }
            move_with_alias(&source, &canonical)?;
            migrated = true;
        } else {
            fs::create_dir_all(canonical.parent().expect("workspace parent"))?;
            assert_atomic(&source, &canonical)?;
            ensure_identity(&source, org)?;
            let mut all = aliases(&source)?;
            all.insert(source.to_string_lossy().to_string());
            save_aliases(&source, all, cwd)?;
            move_with_alias(&source, &canonical)?;
            migrated = true;
        }
    }
    if !migrated && mapped && !stat(&canonical).is_some_and(|m| m.is_dir()) {
        return Err(invalid("Mapped organization Library folder is missing"));
    }
    assert_owned(&canonical)?;
    fs::create_dir_all(&canonical)?;
    assert_owned(&canonical)?;
    ensure_identity(&canonical, org)?;
    for directory in ["agents", "skills", "projects"] {
        fs::create_dir_all(canonical.join(directory))?;
    }
    Ok(canonical)
}
