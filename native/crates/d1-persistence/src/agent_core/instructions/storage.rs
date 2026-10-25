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
pub(super) fn check_identity(root: &Path, org: &str) -> io::Result<()> {
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
/// Read-only ownership preflight for runtime identity resolution. Unlike
/// `ensure`, this never migrates, creates, or rewrites workspace state.
pub(super) fn validate_readonly(host: &Host, org: &str, canonical: &Path) -> io::Result<()> {
    assert_owned(canonical)?;
    validate_readonly_path(Path::new(&host.workspace_home), canonical)?;
    let instance = Path::new(&host.instance_root);
    let canonical_storage = instance.join("organizations").join(key(org));
    let legacy_storage = instance.join("organizations").join(org);
    let canonical_legacy_workspace = canonical_storage.join("workspaces");
    let legacy_workspace = legacy_storage.join("workspaces");
    for workspace in [
        canonical,
        canonical_legacy_workspace.as_path(),
        legacy_workspace.as_path(),
        Path::new(&host.previous_documents_root),
    ] {
        check_identity(workspace, org)?;
    }
    Ok(())
}

/// Require every existing component beneath a trusted root to be a real path
/// component. This is used only by Native Chat's read-only resolver; legacy
/// recovery retains its existing alias and migration behavior.
pub(super) fn validate_readonly_path(root: &Path, target: &Path) -> io::Result<()> {
    if !target.starts_with(root) {
        return Err(invalid("Runtime instruction path escaped its trusted root"));
    }
    let mut cursor = root.to_path_buf();
    for component in target
        .strip_prefix(root)
        .map_err(io::Error::other)?
        .components()
    {
        match component {
            std::path::Component::CurDir => continue,
            std::path::Component::Normal(part) => cursor.push(part),
            _ => return Err(invalid("Runtime instruction path is not normalized")),
        }
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid("Runtime instruction path contains a symlink"));
            }
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
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
fn reserved_folder(value: &str) -> bool {
    [
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
fn valid_folder(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !reserved_folder(value)
}
fn sanitize_friendly_segment(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return fallback.to_owned();
    }
    let mut output = String::new();
    let mut in_invalid_run = false;
    for character in trimmed.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            output.push(character);
            in_invalid_run = false;
        } else if !in_invalid_run {
            output.push('-');
            in_invalid_run = true;
        }
    }
    let sanitized = output.trim_matches('-');
    if sanitized.is_empty() {
        fallback.to_owned()
    } else {
        sanitized.to_owned()
    }
}
fn sanitize_workspace_folder(value: &str, fallback: &str) -> String {
    let safe_fallback = sanitize_friendly_segment(fallback, "_default")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let normalized_fallback = if reserved_folder(&safe_fallback) {
        format!("organization-{safe_fallback}")
    } else {
        safe_fallback
    };
    let sanitized = sanitize_friendly_segment(value, fallback)
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !sanitized.is_empty() && !reserved_folder(&sanitized) {
        sanitized
    } else {
        normalized_fallback
    }
}
pub(super) fn root(host: &Host, org: &str) -> io::Result<(PathBuf, bool)> {
    let home = Path::new(&host.workspace_home);
    if !host.friendly_workspace_home {
        return Ok((home.join(key(org)).join("workspaces"), false));
    }
    let map = workspace_map(home)?;
    let records = map["organizations"].as_array().expect("validated map");
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
fn workspace_map(home: &Path) -> io::Result<Value> {
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
    Ok(map)
}

/// Called under the shared workspace-map lock. This mirrors the Node named
/// organization path: claim a friendly folder and publish its identity before
/// the mapping record, or update the existing record's display metadata.
pub(super) fn ensure_workspace_mapping(host: &Host, org: &str, name: &str) -> io::Result<()> {
    validate_org_path_segment(org)?;
    let home = Path::new(&host.workspace_home);
    let map_path = home.join(".rudder-organizations.json");
    let mut map = workspace_map(home)?;
    let instance = Path::new(&host.instance_root)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("Invalid instance root"))?;

    let existing = map["organizations"]
        .as_array()
        .expect("validated map")
        .iter()
        .position(|record| record["instanceId"] == instance && record["orgId"] == org);
    if let Some(index) = existing {
        let now = super::super::common::now();
        map["organizations"][index]["orgName"] = json!(name);
        map["organizations"][index]["updatedAt"] = json!(now);
        atomic_json(&map_path, &map)?;
        return Ok(());
    }

    let fallback = key(org);
    let base = sanitize_workspace_folder(name, &fallback);
    let used = map["organizations"]
        .as_array()
        .expect("validated map")
        .iter()
        .filter(|record| record["instanceId"] == instance && record["orgId"] != org)
        .filter_map(|record| record["folderName"].as_str())
        .map(str::to_ascii_lowercase)
        .collect::<BTreeSet<_>>();
    for attempt in 1..10_000 {
        let folder = if attempt == 1 {
            base.clone()
        } else {
            format!("{base}-{attempt}")
        };
        if used.contains(&folder.to_ascii_lowercase()) {
            continue;
        }
        let folder_root = home.join(&folder);
        if let Some(metadata) = lstat(&folder_root)? {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            if folder == base && same_identity(&folder_root, org) {
                let now = super::super::common::now();
                let record = json!({
                    "instanceId": instance,
                    "orgId": org,
                    "folderName": folder,
                    "orgName": name,
                    "createdAt": now,
                    "updatedAt": now
                });
                if !valid_folder(record["folderName"].as_str().expect("string")) {
                    return Err(invalid("Invalid organization workspace folder mapping"));
                }
                map["organizations"]
                    .as_array_mut()
                    .expect("validated map")
                    .push(record);
                atomic_json(&map_path, &map)?;
                return Ok(());
            }
            continue;
        }

        fs::create_dir_all(&folder_root)?;
        ensure_identity(&folder_root, org)?;
        let now = super::super::common::now();
        map["organizations"]
            .as_array_mut()
            .expect("validated map")
            .push(json!({
                "instanceId": instance,
                "orgId": org,
                "folderName": folder,
                "orgName": name,
                "createdAt": now,
                "updatedAt": now
            }));
        atomic_json(&map_path, &map)?;
        return Ok(());
    }
    Err(invalid(
        "Unable to allocate organization workspace folder name",
    ))
}

fn validate_org_path_segment(org: &str) -> io::Result<()> {
    if org.is_empty()
        || org.trim() != org
        || !org
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(invalid("Invalid organization id for workspace path"));
    }
    Ok(())
}

fn remove_if_exists(target: &Path) -> io::Result<()> {
    let Some(metadata) = lstat(target)? else {
        return Ok(());
    };
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    };
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Remove only the organization-owned workspace and legacy storage roots.
/// The caller performs the database deletion first and treats this cleanup as
/// best effort, matching the former `removeOrganizationStorage` boundary.
pub(super) fn remove(host: &Host, org: &str) -> io::Result<()> {
    validate_org_path_segment(org)?;
    if host.hostname.trim().is_empty()
        || [
            &host.instance_root,
            &host.workspace_home,
            &host.previous_documents_root,
        ]
        .iter()
        .any(|path| !Path::new(path).is_absolute())
    {
        return Err(invalid("Invalid organization workspace host facts"));
    }

    let home = Path::new(&host.workspace_home);
    let _guard = super::lock::Guard::acquire(home, &host.hostname)?;
    let (workspace, mapped) = root(host, org)?;
    let instance = Path::new(&host.instance_root);
    let canonical_org = instance.join("organizations").join(key(org));
    let legacy_org = instance.join("organizations").join(org);
    let canonical_workspace = canonical_org.join("workspaces");
    let legacy_workspace = legacy_org.join("workspaces");
    let previous_workspace = PathBuf::from(&host.previous_documents_root);

    // Reject known foreign ownership before removing any of the containing
    // organization roots. Friendly mapped folders also require the exact
    // marker expected by Node's removal guard.
    for candidate in [
        workspace.as_path(),
        canonical_workspace.as_path(),
        legacy_workspace.as_path(),
        previous_workspace.as_path(),
    ] {
        check_identity(candidate, org)?;
    }
    if host.friendly_workspace_home && lstat(&workspace)?.is_some() {
        assert_owned(&workspace)?;
        if !same_identity(&workspace, org) {
            return Err(invalid("Organization workspace identity mismatch"));
        }
    }

    let map_path = home.join(".rudder-organizations.json");
    let mut map = workspace_map(home)?;
    let records = map["organizations"].as_array().expect("validated map");
    let instance_id = instance
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("Invalid instance root"))?;
    if mapped {
        let folder = records
            .iter()
            .find(|record| record["instanceId"] == instance_id && record["orgId"] == org)
            .and_then(|record| record["folderName"].as_str())
            .ok_or_else(|| invalid("Invalid organization workspace mapping file"))?;
        if records.iter().any(|record| {
            record["instanceId"] == instance_id
                && record["orgId"] != org
                && record["folderName"]
                    .as_str()
                    .is_some_and(|other| other.eq_ignore_ascii_case(folder))
        }) {
            return Err(invalid(
                "Organization workspace folder is also mapped to another organization",
            ));
        }
    }

    let original_len = records.len();
    let retained = records
        .iter()
        .filter(|record| !(record["instanceId"] == instance_id && record["orgId"] == org))
        .cloned()
        .collect::<Vec<_>>();
    let map_changed = retained.len() != original_len;

    let projects = instance.join("projects").join(org);
    let targets = BTreeSet::from([
        canonical_org,
        workspace,
        legacy_org,
        previous_workspace,
        projects,
    ]);
    for target in targets {
        remove_if_exists(&target)?;
    }

    if map_changed {
        map["organizations"] = json!(retained);
        atomic_json(&map_path, &map)?;
    }
    Ok(())
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
