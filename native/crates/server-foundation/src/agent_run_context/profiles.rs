//! Agent-mode provider profile preparation from the current Node adapters.
//! Operator configuration is read-only; only existing Rudder-managed homes
//! and one invocation's private files are written.
use super::{AgentRunContextHost, ContextError, artifacts::private_write, text};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

pub(super) fn prepare(
    runtime: &str,
    org: &str,
    agent: &str,
    config: &Value,
    host: &AgentRunContextHost,
) -> Result<PathBuf, ContextError> {
    // The external Hermes Agent adapter uses the operator profile directly;
    // it has no Native Chat ACP bootstrap or managed-home preparation.
    if runtime == "hermes_local" {
        return Ok(host.operator_home.join(".hermes"));
    }
    if !matches!(
        runtime,
        "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local"
    ) {
        return Ok(host.runtime_root.clone());
    }
    let storage_key = org.replace('-', "").chars().take(12).collect::<String>();
    let organization = Path::new(&host.workspace.instance_root)
        .join("organizations")
        .join(storage_key);
    let root = if runtime == "codex_local" {
        organization.join("codex-home/agents").join(agent)
    } else {
        organization.join(format!("{}-home", runtime.trim_end_matches("_local")))
    };
    managed_directory(&root)?;
    match runtime {
        "codex_local" => {
            let source = text(&config["env"], "CODEX_HOME")
                .map(|path| {
                    let path = PathBuf::from(path);
                    if path.is_absolute() {
                        path
                    } else {
                        host.process_cwd.join(path)
                    }
                })
                .or_else(|| {
                    host.environment
                        .get("CODEX_HOME")
                        .cloned()
                        .filter(|s| !s.trim().is_empty())
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|| host.operator_home.join(".codex"));
            if source != root {
                mirror_codex_auth(&source.join("auth.json"), &root.join("auth.json"))?;
                let content = fs::read_to_string(source.join("config.toml")).unwrap_or_default();
                if root
                    .join("config.toml")
                    .symlink_metadata()
                    .is_ok_and(|m| m.file_type().is_symlink())
                {
                    fs::remove_file(root.join("config.toml"))?;
                }
                private_write(
                    &root.join("config.toml"),
                    sanitize_codex_config(&content).as_bytes(),
                )?;
            }
        }
        "claude_local" => {
            managed_directory(&root.join(".claude"))?;
            managed_directory(&root.join(".config"))?;
            for relative in [".config/claude", ".config/anthropic", ".anthropic"] {
                share_provider_entry(&host.operator_home.join(relative), &root.join(relative))?;
            }
        }
        "opencode_local" => {
            for relative in [
                ".local",
                ".local/share",
                ".cache",
                ".config",
                ".config/opencode",
                ".config/opencode/skills",
            ] {
                managed_directory(&root.join(relative))?;
            }
            for relative in [".local/share/opencode", ".cache/opencode"] {
                share_provider_entry(&host.operator_home.join(relative), &root.join(relative))?;
            }
        }
        "pi_local" => {
            let source = host.operator_home.join(".pi");
            let target = root.join(".pi");
            for relative in ["", "agent", "agent/skills", "paperclips"] {
                managed_directory(&target.join(relative))?;
            }
            for entry in fs::read_dir(&source).into_iter().flatten() {
                let entry = entry?;
                let name = entry.file_name();
                if name == "agent" || name == "paperclips" {
                    continue;
                }
                share_provider_entry(&entry.path(), &target.join(name))?;
            }
            for entry in fs::read_dir(source.join("agent")).into_iter().flatten() {
                let entry = entry?;
                let name = entry.file_name();
                if name == "skills" {
                    continue;
                }
                share_provider_entry(&entry.path(), &target.join("agent").join(name))?;
            }
        }
        "cursor" => {
            managed_directory(&root.join(".cursor"))?;
            managed_directory(&root.join(".cursor/skills"))?;
        }
        _ => (),
    }
    Ok(root)
}

/// Detach a known Rudder-managed structural link before creating files.
/// Preserve its target and all ordinary existing files/directories.
fn managed_directory(path: &Path) -> Result<(), ContextError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        fs::remove_file(path)?;
    }
    fs::create_dir_all(path)?;
    Ok(())
}

fn mirror_codex_auth(source: &Path, target: &Path) -> Result<(), ContextError> {
    if source.exists() {
        return snapshot_file(source, target);
    }
    // The shared operator auth file is the source of truth. A removed login
    // must not leave a usable stale snapshot in this managed Agent profile.
    if fs::symlink_metadata(target)
        .is_ok_and(|metadata| metadata.is_file() || metadata.file_type().is_symlink())
    {
        fs::remove_file(target)?;
    }
    Ok(())
}

fn snapshot_file(source: &Path, target: &Path) -> Result<(), ContextError> {
    if target
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        fs::remove_file(target)?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    private_write(target, &fs::read(source)?)?;
    Ok(())
}
fn share_provider_entry(source: &Path, target: &Path) -> Result<(), ContextError> {
    if !source.exists() {
        return Ok(());
    }
    if let Ok(metadata) = target.symlink_metadata() {
        if metadata.file_type().is_symlink() {
            let linked = fs::read_link(target)?;
            let actual = if linked.is_absolute() {
                linked
            } else {
                target.parent().unwrap_or(Path::new(".")).join(linked)
            };
            if actual == source {
                return Ok(());
            }
            fs::remove_file(target)?;
        } else {
            return Ok(());
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target)?;
    }
    #[cfg(windows)]
    {
        if source.is_dir() {
            std::os::windows::fs::symlink_dir(source, target)?;
        } else {
            std::os::windows::fs::symlink_file(source, target)?;
        }
    }
    Ok(())
}

pub(super) fn sanitize_codex_config(content: &str) -> String {
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut output = Vec::new();
    let mut skip = false;
    let mut in_table = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_table = true;
            skip = trimmed.starts_with("[mcp_servers")
                || trimmed.starts_with("[plugins.")
                || trimmed == "[[skills.config]]"
                || trimmed == "[skills.bundled]";
        }
        if skip {
            continue;
        }
        if !in_table {
            let key = trimmed.split_once('=').map(|(key, _)| key.trim());
            if key == Some("notify") {
                continue;
            }
            if key == Some("service_tier") {
                let value = trimmed
                    .split_once('=')
                    .map(|(_, value)| {
                        value
                            .split('#')
                            .next()
                            .unwrap_or_default()
                            .trim()
                            .trim_matches(['\'', '"'])
                    })
                    .unwrap_or_default();
                if !matches!(value.to_ascii_lowercase().as_str(), "fast" | "flex") {
                    continue;
                }
            }
        }
        output.push(line);
    }
    output.join(newline)
}

pub(super) fn codex_disabled_skill_paths(
    config: &Value,
    cwd: &Path,
    host: &AgentRunContextHost,
) -> Vec<PathBuf> {
    let shared = text(&config["env"], "CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| host.environment.get("CODEX_HOME").map(PathBuf::from))
        .unwrap_or_else(|| host.operator_home.join(".codex"));
    let mut paths = BTreeSet::new();
    for root in [
        host.operator_home.join(".agents/skills"),
        shared.join("skills"),
        cwd.join(".agents/skills"),
    ] {
        paths.insert(root.clone());
        if root.join("SKILL.md").exists() {
            paths.insert(root.join("SKILL.md"));
        }
        for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) && entry.path().join("SKILL.md").exists()
            {
                paths.insert(entry.path());
                paths.insert(entry.path().join("SKILL.md"));
            }
        }
    }
    paths.into_iter().collect()
}

pub(super) fn opencode_base(host: &AgentRunContextHost) -> Value {
    let mut source = json!({});
    for filename in ["opencode.json", "opencode.jsonc"] {
        if let Ok(raw) = fs::read(host.operator_home.join(".config/opencode").join(filename))
            && let Ok(value) = serde_json::from_slice::<Value>(&raw)
        {
            source = value;
            break;
        }
    }
    let mut base = json!({"autoupdate":false,"$schema":"https://opencode.ai/config.json"});
    for key in ["$schema", "model", "small_model", "theme", "username"] {
        if source[key].is_string() {
            base[key] = source[key].clone();
        }
    }
    if source["provider"].is_object() {
        base["provider"] = sanitize_opencode_provider(&source["provider"]);
    }
    base
}
fn sanitize_opencode_provider(value: &Value) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "agent"
                            | "agents"
                            | "mode"
                            | "modes"
                            | "skill"
                            | "skills"
                            | "plugin"
                            | "plugins"
                            | "tools"
                            | "command"
                            | "commands"
                            | "hooks"
                            | "mcp"
                    )
                })
                .map(|(key, value)| (key.clone(), sanitize_opencode_provider(value)))
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.iter().map(sanitize_opencode_provider).collect())
        }
        value => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removed_operator_codex_auth_revokes_only_the_managed_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let operator = root.path().join("operator");
        let managed = root.path().join("managed");
        fs::create_dir_all(&operator).unwrap();
        fs::create_dir_all(&managed).unwrap();
        let source = operator.join("auth.json");
        let target = managed.join("auth.json");
        fs::write(&source, "synthetic login").unwrap();
        fs::write(managed.join("custom"), "operator customization").unwrap();
        mirror_codex_auth(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "synthetic login");
        fs::remove_file(&source).unwrap();
        mirror_codex_auth(&source, &target).unwrap();
        assert!(!target.exists());
        assert!(operator.is_dir());
        assert_eq!(
            fs::read_to_string(managed.join("custom")).unwrap(),
            "operator customization"
        );
    }
    #[cfg(unix)]
    #[test]
    fn managed_structural_symlink_is_detached_without_touching_operator_files() {
        let root = tempfile::tempdir().unwrap();
        let operator = root.path().join("operator");
        fs::create_dir(&operator).unwrap();
        fs::write(operator.join("keep"), "operator configuration").unwrap();
        let managed = root.path().join("managed");
        std::os::unix::fs::symlink(&operator, &managed).unwrap();
        managed_directory(&managed).unwrap();
        fs::write(managed.join("isolated"), "managed").unwrap();
        assert_eq!(
            fs::read_to_string(operator.join("keep")).unwrap(),
            "operator configuration"
        );
        assert!(!operator.join("isolated").exists());
        fs::write(managed.join("custom"), "user file").unwrap();
        managed_directory(&managed).unwrap();
        assert_eq!(
            fs::read_to_string(managed.join("custom")).unwrap(),
            "user file"
        );
    }
    #[test]
    fn codex_provider_routes_survive_while_operator_mcp_and_notify_do_not() {
        let value = sanitize_codex_config(
            "model_provider=\"custom\"\nnotify=[\"external-hook\"]\nservice_tier=\"unsupported\"\n[model_providers.custom]\nbase_url=\"https://provider.invalid\"\n[mcp_servers.hidden]\ncommand=\"hidden\"\n[features]\nplugins=false",
        );
        assert!(value.contains("model_providers.custom"));
        assert!(!value.contains("hidden"));
        assert!(!value.contains("notify"));
        assert!(!value.contains("service_tier"));
    }
    #[test]
    fn opencode_provider_sanitizer_preserves_connection_options() {
        let value = sanitize_opencode_provider(
            &json!({"custom":{"options":{"baseURL":"https://provider.invalid","apiKey":"fixture"},"mcp":{"hidden":{}},"models":{"model":{}}}}),
        );
        assert!(value["custom"]["options"].is_object());
        assert!(value["custom"].get("mcp").is_none());
        assert!(value["custom"]["models"].is_object());
    }
}
