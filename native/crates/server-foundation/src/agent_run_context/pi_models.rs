//! Existing Pi compatibility for OpenCode's anonymous model IDs. This touches
//! only Rudder's managed profile; inherited provider symlinks are detached.
use super::{ContextError, artifacts::private_write, text};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path};
pub(super) fn prepare(
    config: &Value,
    env: &BTreeMap<String, String>,
    profile: &Path,
) -> Result<bool, ContextError> {
    let model = text(config, "model").unwrap_or_default();
    let Some((provider, model)) = model.split_once('/') else {
        return Ok(false);
    };
    if provider.trim() != "opencode"
        || !(model.trim() == "big-pickle" || model.trim().ends_with("-free"))
        || env
            .get("OPENCODE_API_KEY")
            .is_some_and(|v| !v.trim().is_empty())
    {
        return Ok(false);
    }
    let agent = profile.join(".pi/agent");
    fs::create_dir_all(&agent)?;
    let file = agent.join("models.json");
    let existing = fs::symlink_metadata(&file).ok();
    if existing.as_ref().is_some_and(|m| m.is_dir()) {
        return Ok(false);
    }
    let symlink = existing
        .as_ref()
        .is_some_and(|m| m.file_type().is_symlink());
    let mut models = if symlink {
        json!({})
    } else {
        fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|v| v.is_object())
            .unwrap_or_else(|| json!({}))
    };
    if !models["providers"].is_object() {
        models["providers"] = json!({});
    }
    if !models["providers"]["opencode"].is_object() {
        models["providers"]["opencode"] = json!({});
    }
    let provider = &mut models["providers"]["opencode"];
    if !provider["apiKey"].is_string() {
        provider["apiKey"] = json!("RUDDER_OPENCODE_ANONYMOUS");
    }
    provider["authHeader"] = json!(false);
    if !provider["headers"].is_object() {
        provider["headers"] = json!({});
    }
    provider["headers"]["Authorization"] = json!("");
    if symlink {
        fs::remove_file(&file)?;
    }
    let mut bytes = serde_json::to_vec_pretty(&models)
        .map_err(|_| ContextError::Invalid("Pi managed model configuration failed"))?;
    bytes.push(b'\n');
    private_write(&file, &bytes)?;
    let settings = agent.join("settings.json");
    if fs::symlink_metadata(&settings).is_ok_and(|m| m.file_type().is_symlink()) {
        fs::remove_file(settings)?;
    }
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn anonymous_model_profile_preserves_other_providers_and_explicit_api_key_opt_out() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".pi/agent")).unwrap();
        let file = root.path().join(".pi/agent/models.json");
        fs::write(
            &file,
            r#"{"providers":{"other":{"baseUrl":"https://fixture.invalid"}}}"#,
        )
        .unwrap();
        assert!(
            prepare(
                &json!({"model":"opencode/big-pickle"}),
                &BTreeMap::new(),
                root.path()
            )
            .unwrap()
        );
        let value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(value["providers"]["opencode"]["authHeader"], false);
        assert_eq!(
            value["providers"]["other"]["baseUrl"],
            "https://fixture.invalid"
        );
        let before = fs::read(&file).unwrap();
        assert!(
            !prepare(
                &json!({"model":"opencode/big-pickle"}),
                &BTreeMap::from([("OPENCODE_API_KEY".into(), "synthetic-fixture-key".into())]),
                root.path()
            )
            .unwrap()
        );
        assert_eq!(fs::read(&file).unwrap(), before);
    }
    #[cfg(unix)]
    #[test]
    fn managed_model_bootstrap_detaches_operator_symlinks_without_mutating_source() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("operator-models.json");
        fs::write(&source, "{\"operator\":true}").unwrap();
        let profile = root.path().join("managed");
        let agent = profile.join(".pi/agent");
        fs::create_dir_all(&agent).unwrap();
        std::os::unix::fs::symlink(&source, agent.join("models.json")).unwrap();
        prepare(
            &json!({"model":"opencode/example-free"}),
            &BTreeMap::new(),
            &profile,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(source).unwrap(), "{\"operator\":true}");
        assert!(
            !fs::symlink_metadata(agent.join("models.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
