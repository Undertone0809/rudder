use crate::{Error, HostPaths, Result};
use rudder_d1_persistence::native_chat::config::ResolvedCodexConfig;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

const MARKER: &str = "rudder-native-chat-profile-v1\n";
const MARKER_FILE: &str = ".rudder-native-chat-profile";
const CONFIG: &str = "approval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\nweb_search = \"disabled\"\n[features]\nplugins = false\nhooks = false\napps = false\nbrowser_use = false\ncomputer_use = false\nimage_generation = false\nmulti_agent = false\nskill_search = false\nskill_mcp_dependency_install = false\nskip_host_skill_discovery = true\n[mcp_servers]\n";

/// Provision only an empty canonical directory, or verify an existing native
/// profile. Never overwrite/copy a Node/operator profile, config, or auth.json.
/// Authentication must be provisioned separately through its authorized flow.
pub fn provision_profile(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path.canonicalize().as_ref().ok() != Some(&path.to_path_buf())
        || !path.is_dir()
    {
        return Err(Error::UnsupportedConfiguration);
    }
    let mut entries = fs::read_dir(path).map_err(|_| Error::UnsupportedConfiguration)?;
    if entries.next().is_some() {
        return verify_profile(path);
    }
    write_new(&path.join("config.toml"), CONFIG)?;
    write_new(&path.join(MARKER_FILE), MARKER)?;
    verify_profile(path)
}

fn write_new(path: &Path, content: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| Error::UnsupportedConfiguration)?;
    file.write_all(content.as_bytes())
        .map_err(|_| Error::UnsupportedConfiguration)?;
    file.sync_all().map_err(|_| Error::UnsupportedConfiguration)
}

fn exact_file(path: &Path, content: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::UnsupportedConfiguration)?;
    if !metadata.is_file() || metadata.len() != content.len() as u64 {
        return Err(Error::UnsupportedConfiguration);
    }
    if fs::read(path).map_err(|_| Error::UnsupportedConfiguration)? != content.as_bytes() {
        return Err(Error::UnsupportedConfiguration);
    }
    Ok(())
}

fn verify_profile(path: &Path) -> Result<()> {
    if path.canonicalize().as_ref().ok() != Some(&path.to_path_buf()) {
        return Err(Error::UnsupportedConfiguration);
    }
    exact_file(&path.join(MARKER_FILE), MARKER)?;
    exact_file(&path.join("config.toml"), CONFIG)?;
    for entry in ["plugins", "hooks.json", "managed_config.toml"] {
        if fs::symlink_metadata(path.join(entry)).is_ok() {
            return Err(Error::UnsupportedConfiguration);
        }
    }
    let skills = path.join("skills");
    match fs::symlink_metadata(&skills) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err(Error::UnsupportedConfiguration),
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err(Error::UnsupportedConfiguration);
            }
            for entry in fs::read_dir(skills).map_err(|_| Error::UnsupportedConfiguration)? {
                let entry = entry.map_err(|_| Error::UnsupportedConfiguration)?;
                if entry.file_name() != ".system"
                    || !entry
                        .file_type()
                        .map_err(|_| Error::UnsupportedConfiguration)?
                        .is_dir()
                {
                    return Err(Error::UnsupportedConfiguration);
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn validate(config: &ResolvedCodexConfig, paths: &HostPaths) -> Result<()> {
    if config.plan_mode || config.search_enabled {
        return Err(Error::UnsupportedConfiguration);
    }
    verify_profile(&config.profile.home)?;
    // Child startup CWD/HOME are isolated. Reject workspace config/skill inputs
    // until native capability provenance is represented in the runtime binding.
    for root in [&config.cwd, &paths.isolated_home] {
        let mut ancestor = Some(root.as_path());
        while let Some(path) = ancestor {
            for relative in [".codex/config.toml", ".codex/skills", ".agents/skills"] {
                if fs::symlink_metadata(path.join(relative)).is_ok() {
                    return Err(Error::UnsupportedConfiguration);
                }
            }
            ancestor = path.parent();
        }
    }
    Ok(())
}

pub(crate) fn validate_layers(value: &Value, profile_home: &Path) -> Result<()> {
    let layers = value["layers"]
        .as_array()
        .ok_or(Error::UnsupportedConfiguration)?;
    let expected_path = profile_home.join("config.toml");
    let mut saw_profile = false;
    for layer in layers {
        let raw = layer["config"]
            .as_object()
            .ok_or(Error::UnsupportedConfiguration)?;
        match layer["name"]["type"].as_str() {
            Some("user")
                if layer["name"]["file"].as_str() == expected_path.to_str()
                    && layer["name"]["profile"].is_null()
                    && layer["disabledReason"].is_null() =>
            {
                if saw_profile {
                    return Err(Error::UnsupportedConfiguration);
                }
                saw_profile = true;
                if raw.len() != 5
                    || raw.get("approval_policy").and_then(Value::as_str) != Some("on-request")
                    || raw.get("sandbox_mode").and_then(Value::as_str) != Some("read-only")
                    || raw.get("web_search").and_then(Value::as_str) != Some("disabled")
                    || !raw
                        .get("mcp_servers")
                        .and_then(Value::as_object)
                        .is_some_and(|v| v.is_empty())
                {
                    return Err(Error::UnsupportedConfiguration);
                }
                let features = raw
                    .get("features")
                    .and_then(Value::as_object)
                    .ok_or(Error::UnsupportedConfiguration)?;
                const DISABLED: &[&str] = &[
                    "plugins",
                    "hooks",
                    "apps",
                    "browser_use",
                    "computer_use",
                    "image_generation",
                    "multi_agent",
                    "skill_search",
                    "skill_mcp_dependency_install",
                ];
                if features.len() != DISABLED.len() + 1
                    || DISABLED
                        .iter()
                        .any(|key| features.get(*key) != Some(&Value::Bool(false)))
                    || features.get("skip_host_skill_discovery") != Some(&Value::Bool(true))
                {
                    return Err(Error::UnsupportedConfiguration);
                }
            }
            Some("sessionFlags")
                if layer["config"] == serde_json::json!({"features":{"plugins":false}}) => {}
            // Reject every nonempty or unknown source, even a disabled project
            // layer, until its provenance and capabilities are explicitly mapped.
            Some("system" | "packagedDefaults") if raw.is_empty() => (),
            _ => return Err(Error::UnsupportedConfiguration),
        }
    }
    if !saw_profile
        || value["config"]["approval_policy"] != "on-request"
        || value["config"]["sandbox_mode"] != "read-only"
        || value["config"]["web_search"] != "disabled"
    {
        return Err(Error::UnsupportedConfiguration);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn observed(home: &Path) -> Value {
        json!({"config":{"approval_policy":"on-request","sandbox_mode":"read-only","web_search":"disabled"},
            "layers":[{"name":{"type":"user","file":home.join("config.toml"),"profile":null},"config":{
                "approval_policy":"on-request","sandbox_mode":"read-only","web_search":"disabled","mcp_servers":{},
                "features":{"plugins":false,"hooks":false,"apps":false,"browser_use":false,"computer_use":false,
                    "image_generation":false,"multi_agent":false,"skill_search":false,"skill_mcp_dependency_install":false,
                    "skip_host_skill_discovery":true}}}]})
    }

    #[test]
    fn layer_provenance_rejects_project_mcp_and_policy_drift() {
        let home = Path::new("/native-profile");
        let valid = observed(home);
        assert!(validate_layers(&valid, home).is_ok());
        let mut project = valid.clone();
        project["layers"].as_array_mut().unwrap().push(json!({"name":{"type":"project","dotCodexFolder":"/workspace/.codex"},"disabledReason":"untrusted","config":{}}));
        assert!(validate_layers(&project, home).is_err());
        let mut mcp = valid.clone();
        mcp["layers"][0]["config"]["mcp_servers"] = json!({"hidden":{"command":"unsafe"}});
        assert!(validate_layers(&mcp, home).is_err());
        let mut policy = valid.clone();
        policy["config"]["sandbox_mode"] = json!("danger-full-access");
        assert!(validate_layers(&policy, home).is_err());
        assert!(validate_layers(&valid, Path::new("/other-profile")).is_err());
        assert!(validate_layers(&json!({"layers":[]}), home).is_err());
    }

    #[test]
    fn native_profile_provision_is_idempotent_and_never_overwrites_existing_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        provision_profile(&path).unwrap();
        provision_profile(&path).unwrap();
        fs::write(path.join("config.toml"), "private existing config").unwrap();
        assert!(provision_profile(&path).is_err());
        assert_eq!(
            fs::read_to_string(path.join("config.toml")).unwrap(),
            "private existing config"
        );
        let existing = tempfile::tempdir().unwrap();
        fs::write(existing.path().join("auth.json"), "do not overwrite").unwrap();
        assert!(provision_profile(&existing.path().canonicalize().unwrap()).is_err());
        assert!(!existing.path().join("config.toml").exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_profile_refuses_symlink_config_and_capability_directories() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap();
        provision_profile(&path).unwrap();
        fs::create_dir_all(path.join("skills/custom")).unwrap();
        assert!(verify_profile(&path).is_err());
        fs::remove_dir_all(path.join("skills")).unwrap();
        std::os::unix::fs::symlink("missing-skills", path.join("skills")).unwrap();
        assert!(verify_profile(&path).is_err());
        fs::remove_file(path.join("skills")).unwrap();
        fs::rename(path.join("config.toml"), path.join("source.toml")).unwrap();
        std::os::unix::fs::symlink("source.toml", path.join("config.toml")).unwrap();
        assert!(verify_profile(&path).is_err());
    }
}
