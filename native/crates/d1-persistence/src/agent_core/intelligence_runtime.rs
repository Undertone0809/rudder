//! First-Agent intelligence seed preflight.
//!
//! This is deliberately limited to the existing runtime-chain check used by
//! organization intelligence defaults. It does not select runtime fallbacks
//! for an Agent run, create provider profiles, or persist resolved secrets.
mod process_http;

use super::common::Tx;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeSet,
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Target {
    pub(super) label: String,
    pub(super) runtime_type: String,
    pub(super) config: Value,
    pub(super) organization_id: String,
}

#[derive(Debug)]
struct ProcessOutput {
    status: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

pub(super) async fn resolve_targets(
    tx: &mut Tx<'_>,
    org_id: &str,
    runtime_type: &str,
    config: &Value,
) -> Result<Vec<Target>, String> {
    let mut targets = build_targets(runtime_type, config);
    for target in &mut targets {
        target.organization_id = org_id.to_owned();
        target.config = resolve_runtime_config(tx, org_id, &target.config).await?;
    }
    Ok(targets)
}

pub(super) async fn assert_usable(targets: &[Target]) -> Result<(), String> {
    for target in targets {
        if let Some(message) = test_environment(
            &target.organization_id,
            &target.runtime_type,
            &target.config,
        )
        .await?
        {
            return Err(format!(
                "Runtime chain test failed for {}: {message}",
                target.label
            ));
        }
    }
    Ok(())
}

fn build_targets(runtime_type: &str, config: &Value) -> Vec<Target> {
    let Some(primary) = config.as_object() else {
        return vec![Target {
            label: "Primary".to_owned(),
            runtime_type: runtime_type.to_owned(),
            config: json!({}),
            organization_id: String::new(),
        }];
    };
    let mut primary_config = primary.clone();
    let fallback_value = primary_config.remove("modelFallbacks");
    let primary_model = primary
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut targets = vec![Target {
        label: "Primary".to_owned(),
        runtime_type: runtime_type.to_owned(),
        config: Value::Object(primary_config),
        organization_id: String::new(),
    }];
    let Some(Value::Array(fallbacks)) = fallback_value else {
        return targets;
    };

    let mut seen = BTreeSet::new();
    if let Some(model) = primary_model {
        seen.insert((runtime_type.to_owned(), model.to_owned()));
    }
    for fallback in fallbacks {
        let record = fallback.as_object();
        let fallback_runtime = record
            .and_then(|record| record.get("agentRuntimeType"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(runtime_type);
        let model = record
            .and_then(|record| record.get("model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                fallback
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            });
        let Some(model) = model else { continue };
        let key = (fallback_runtime.to_owned(), model.to_owned());
        if !seen.insert(key) {
            continue;
        }

        let mut merged = Map::new();
        if let Some(record) = record {
            for (key, value) in record {
                if !matches!(
                    key.as_str(),
                    "agentRuntimeType" | "model" | "modelFallbacks" | "config"
                ) {
                    merged.insert(key.clone(), value.clone());
                }
            }
            if let Some(config) = record.get("config").and_then(Value::as_object) {
                for (key, value) in config {
                    if !matches!(
                        key.as_str(),
                        "agentRuntimeType" | "model" | "modelFallbacks" | "config"
                    ) {
                        merged.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        merged.insert("model".to_owned(), json!(model));
        targets.push(Target {
            label: format!("Fallback {}", targets.len()),
            runtime_type: fallback_runtime.to_owned(),
            config: Value::Object(merged),
            organization_id: String::new(),
        });
    }
    targets
}

async fn resolve_runtime_config(
    tx: &mut Tx<'_>,
    org_id: &str,
    config: &Value,
) -> Result<Value, String> {
    let mut config = config
        .as_object()
        .cloned()
        .ok_or_else(|| "agentRuntimeConfig must be an object".to_owned())?;
    let Some(Value::Object(bindings)) = config.get("env").cloned() else {
        return Ok(Value::Object(config));
    };
    let mut env = Map::new();
    for (key, binding) in bindings {
        match binding {
            Value::String(value) => {
                env.insert(key, json!(value));
            }
            Value::Object(binding)
                if binding.get("type").and_then(Value::as_str) == Some("plain") =>
            {
                let value = binding
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                env.insert(key, json!(value));
            }
            Value::Object(binding)
                if binding.get("type").and_then(Value::as_str) == Some("secret_ref") =>
            {
                let value = super::super::secrets::resolve_local_runtime_secret_reference(
                    tx,
                    org_id,
                    &Value::Object(binding),
                )
                .await
                .map_err(|error| match error {
                    super::super::secrets::SecretsError::Http(_, message) => message,
                    super::super::secrets::SecretsError::Database(_) => {
                        "Secret provider unavailable".to_owned()
                    }
                })?
                .ok_or_else(|| "Secret provider is not configured in this deployment".to_owned())?;
                env.insert(key, json!(value));
            }
            _ => return Err("Invalid environment binding".to_owned()),
        }
    }
    config.insert("env".to_owned(), Value::Object(env));
    Ok(Value::Object(config))
}

async fn test_environment(
    organization_id: &str,
    runtime_type: &str,
    config: &Value,
) -> Result<Option<String>, String> {
    match runtime_type {
        "process" => process_http::test_process(config).await,
        "http" => process_http::test_http(config).await,
        "claude_local" => test_claude(organization_id, config).await,
        "codex_local" => test_codex(organization_id, config).await,
        "opencode_local" => test_opencode(config).await,
        "pi_local" => test_pi(organization_id, config).await,
        "cursor" => test_cursor(config).await,
        "openclaw_gateway" => test_openclaw_gateway(config).await,
        "hermes_gateway" => test_hermes_gateway(config).await,
        "hermes_local" => test_hermes_local(config).await,
        _ => Err(format!("Unknown adapter type: {runtime_type}")),
    }
}

fn config_string(config: &Value, key: &str, default: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| default.to_owned())
}

fn configured_env(config: &Value) -> Map<String, Value> {
    config
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn env_value_or_host(config: &Value, key: &str) -> Option<String> {
    config
        .get("env")
        .and_then(|env| env.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var(key).ok())
}

fn env_nonempty(config: &Value, key: &str) -> Option<String> {
    env_value_or_host(config, key).filter(|value| !value.trim().is_empty())
}

fn config_with_env(
    config: &Value,
    additions: impl IntoIterator<Item = (String, String)>,
    protected: &[&str],
) -> Value {
    let mut output = config.as_object().cloned().unwrap_or_default();
    let mut values = configured_env(config);
    for key in protected {
        values.remove(*key);
    }
    for (key, value) in additions {
        values.insert(key, json!(value));
    }
    output.insert("env".to_owned(), Value::Object(values));
    Value::Object(output)
}

fn home_directory(config: &Value, allow_configured_home: bool) -> PathBuf {
    let operator_home = env::var("RUDDER_OPERATOR_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let configured = allow_configured_home
        .then(|| env_value_or_host(config, "HOME"))
        .flatten()
        .filter(|value| !value.trim().is_empty());
    let home = operator_home
        .or_else(|| env::var("HOME").ok())
        .or(configured)
        .or_else(|| env::var("USERPROFILE").ok())
        .unwrap_or_else(|| ".".to_owned());
    absolute_path(PathBuf::from(home))
}

fn absolute_path(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn organization_storage_key(org_id: &str) -> Result<String, String> {
    let value = org_id.trim();
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Invalid organization identity for runtime home".to_owned());
    }
    let bytes = value.as_bytes();
    let is_uuid = bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14].to_ascii_lowercase(), b'1'..=b'5')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b');
    if is_uuid {
        Ok(value
            .bytes()
            .filter(|byte| *byte != b'-')
            .take(12)
            .map(|byte| (byte as char).to_ascii_lowercase())
            .collect())
    } else {
        Ok(value.to_owned())
    }
}

fn rudder_home(config: &Value) -> PathBuf {
    env_nonempty(config, "RUDDER_HOME")
        .map(PathBuf::from)
        .map(absolute_path)
        .unwrap_or_else(|| home_directory(config, false).join(".rudder"))
}

fn managed_runtime_home(config: &Value, org_id: &str, name: &str) -> Result<PathBuf, String> {
    let instance =
        env_nonempty(config, "RUDDER_INSTANCE_ID").unwrap_or_else(|| "default".to_owned());
    if instance.is_empty()
        || !instance
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Invalid Rudder instance identity for runtime home".to_owned());
    }
    Ok(rudder_home(config)
        .join("instances")
        .join(instance)
        .join("organizations")
        .join(organization_storage_key(org_id)?)
        .join(name))
}

fn copy_private_file(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, target).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(target, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_private_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn native_mcp_server_binary() -> Result<PathBuf, String> {
    let current_exe = env::current_exe()
        .map_err(|_| "Rudder native MCP executable is unavailable beside the server".to_owned())?;
    resolve_native_mcp_server_binary(&current_exe)
}

fn resolve_native_mcp_server_binary(current_exe: &Path) -> Result<PathBuf, String> {
    let binary_names = if cfg!(windows) {
        ["rudder-native.exe", "rudder-cli.exe"]
    } else {
        ["rudder-native", "rudder-cli"]
    };
    let current_name = current_exe.file_name().and_then(OsStr::to_str);
    if binary_names.contains(&current_name.unwrap_or_default()) {
        return current_exe.canonicalize().map_err(|_| {
            "Rudder native MCP executable is unavailable beside the server".to_owned()
        });
    }

    let Some(exe_dir) = current_exe.parent() else {
        return Err("Rudder native MCP executable is unavailable beside the server".to_owned());
    };
    let mut search_dirs = vec![exe_dir];
    if exe_dir.file_name().and_then(OsStr::to_str) == Some("deps")
        && let Some(debug_dir) = exe_dir.parent()
    {
        search_dirs.push(debug_dir);
    }
    for directory in search_dirs {
        for binary_name in binary_names {
            let candidate = directory.join(binary_name);
            if candidate.is_file() {
                return candidate.canonicalize().map_err(|_| {
                    "Rudder native MCP executable is unavailable beside the server".to_owned()
                });
            }
        }
    }
    Err("Rudder native MCP executable is unavailable beside the server".to_owned())
}

#[cfg(unix)]
fn symlink_entry(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let linked = fs::read_link(target).map_err(|error| error.to_string())?;
            if absolute_path(
                target
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(linked),
            ) == absolute_path(source.to_path_buf())
            {
                return Ok(());
            }
            fs::remove_file(target).map_err(|error| error.to_string())?;
            symlink(source, target).map_err(|error| error.to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            symlink(source, target).map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(windows)]
fn symlink_entry(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(target).map_err(|error| error.to_string())?;
            if source.is_dir() {
                symlink_dir(source, target).map_err(|error| error.to_string())
            } else {
                symlink_file(source, target).map_err(|error| error.to_string())
            }
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if source.is_dir() {
                symlink_dir(source, target).map_err(|error| error.to_string())
            } else {
                symlink_file(source, target).map_err(|error| error.to_string())
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

fn set_config_env(config: &Value, key: &str, value: impl Into<String>) -> Value {
    config_with_env(config, [(key.to_owned(), value.into())], &[])
}

fn prepare_codex_home(org_id: &str, config: &Value) -> Result<(PathBuf, Value), String> {
    let configured_source = config
        .get("env")
        .and_then(|env| env.get("CODEX_HOME"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let source = configured_source
        .or_else(|| env_nonempty(config, "RUDDER_SHARED_CODEX_HOME").map(PathBuf::from))
        .or_else(|| env::var("RUDDER_SHARED_CODEX_HOME").ok().map(PathBuf::from))
        .or_else(|| env::var("CODEX_HOME").ok().map(PathBuf::from))
        .map(absolute_path)
        .unwrap_or_else(|| home_directory(config, false).join(".codex"));
    let target = managed_runtime_home(config, org_id, "codex-home")?;
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;

    let source_auth = source.join("auth.json");
    let target_auth = target.join("auth.json");
    if source_auth != target_auth {
        if source_auth.is_file() {
            copy_private_file(&source_auth, &target_auth)?;
        } else if fs::symlink_metadata(&target_auth)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            fs::remove_file(&target_auth).map_err(|error| error.to_string())?;
        }
    }
    for name in ["config.json", "instructions.md"] {
        let from = source.join(name);
        let to = target.join(name);
        if from.is_file() && from != to && !to.exists() {
            copy_private_file(&from, &to)?;
        }
    }

    let config_toml = source.join("config.toml");
    let raw = fs::read_to_string(&config_toml).unwrap_or_default();
    let mcp_binary = native_mcp_server_binary()?;
    let sanitized = sanitize_codex_probe_config(&raw, &mcp_binary);
    fs::write(target.join("config.toml"), sanitized).map_err(|error| error.to_string())?;
    let path = target.to_string_lossy().into_owned();
    Ok((target, set_config_env(config, "CODEX_HOME", path)))
}

fn sanitize_codex_probe_config(source: &str, mcp_binary: &Path) -> String {
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines = Vec::new();
    let mut current_table = String::new();
    let mut skip_table = false;
    let mut features_seen = false;
    let mut plugins_seen = false;
    let mut bundled_skills_seen = false;
    let mut bundled_enabled_seen = false;
    for raw_line in source.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let trimmed = line.trim();
        if is_toml_table_boundary(trimmed) {
            append_missing_codex_table_value(
                &mut lines,
                &current_table,
                plugins_seen,
                bundled_enabled_seen,
            );
            current_table = trimmed.to_owned();
            skip_table = codex_managed_table(&current_table);
            if current_table == "[features]" {
                features_seen = true;
                plugins_seen = false;
            }
            if current_table == "[skills.bundled]" {
                bundled_skills_seen = true;
                bundled_enabled_seen = false;
            }
            if skip_table {
                continue;
            }
        }
        if skip_table {
            continue;
        }
        if current_table == "[features]" && toml_key_assignment(trimmed, "plugins") {
            lines.push(format!(
                "{}plugins = false",
                line.trim_start()
                    .chars()
                    .take_while(|ch| ch.is_whitespace())
                    .collect::<String>()
            ));
            plugins_seen = true;
            continue;
        }
        if current_table == "[skills.bundled]" && toml_key_assignment(trimmed, "enabled") {
            lines.push(format!(
                "{}enabled = false",
                line.trim_start()
                    .chars()
                    .take_while(|ch| ch.is_whitespace())
                    .collect::<String>()
            ));
            bundled_enabled_seen = true;
            continue;
        }
        if current_table.is_empty()
            && (toml_key_assignment(trimmed, "notify") || unsupported_codex_service_tier(trimmed))
        {
            continue;
        }
        lines.push(line.to_owned());
    }
    append_missing_codex_table_value(
        &mut lines,
        &current_table,
        plugins_seen,
        bundled_enabled_seen,
    );
    if !features_seen {
        append_codex_table(&mut lines, "[features]", "plugins = false");
    }
    if !bundled_skills_seen {
        append_codex_table(&mut lines, "[skills.bundled]", "enabled = false");
    }
    let command = serde_json::to_string(&mcp_binary.to_string_lossy())
        .expect("a filesystem path can be serialized as a string");
    lines.extend([
        "".to_owned(),
        "[mcp_servers.rudder-tools]".to_owned(),
        format!("command = {command}"),
        "args = [\"mcp-server\"]".to_owned(),
    ]);
    format!("{}{}", lines.join(newline), newline)
}

fn is_toml_table_boundary(line: &str) -> bool {
    (line.starts_with("[[") && line.ends_with("]]"))
        || (line.starts_with('[') && !line.starts_with("[[") && line.ends_with(']'))
}

fn codex_managed_table(table: &str) -> bool {
    table == "[mcp_servers]"
        || (table.starts_with("[mcp_servers.") && table.ends_with(']'))
        || (table.starts_with("[plugins.") && table.ends_with(']'))
        || table == "[[skills.config]]"
}

fn toml_key_assignment(line: &str, key: &str) -> bool {
    line.split_once('=')
        .is_some_and(|(candidate, _)| candidate.trim() == key)
}

fn unsupported_codex_service_tier(line: &str) -> bool {
    let Some((key, raw_value)) = line.split_once('=') else {
        return false;
    };
    if !key.trim().eq_ignore_ascii_case("service_tier") {
        return false;
    }
    let value = raw_value
        .trim()
        .split('#')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_matches(['"', '\''])
        .to_ascii_lowercase();
    !matches!(value.as_str(), "fast" | "flex")
}

fn append_missing_codex_table_value(
    lines: &mut Vec<String>,
    current_table: &str,
    plugins_seen: bool,
    bundled_enabled_seen: bool,
) {
    match current_table {
        "[features]" if !plugins_seen => lines.push("plugins = false".to_owned()),
        "[skills.bundled]" if !bundled_enabled_seen => lines.push("enabled = false".to_owned()),
        _ => {}
    }
}

fn append_codex_table(lines: &mut Vec<String>, table: &str, setting: &str) {
    if !lines.is_empty() && !lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.push(String::new());
    }
    lines.push(table.to_owned());
    lines.push(setting.to_owned());
}

fn prepare_claude_probe_environment(
    org_id: &str,
    config: &Value,
) -> Result<(PathBuf, Value), String> {
    const PROTECTED: &[&str] = &[
        "AGENT_HOME",
        "HOME",
        "RUDDER_AGENT_ROOT",
        "RUDDER_OPERATOR_HOME",
        "USERPROFILE",
    ];
    let operator_home = home_directory(config, false);
    let managed_home = managed_runtime_home(config, org_id, "claude-home")?;
    let claude_dir = managed_home.join(".claude");
    fs::create_dir_all(&managed_home).map_err(|error| error.to_string())?;
    remove_managed_entry(&claude_dir.join("skills"));
    remove_managed_entry(&claude_dir.join("plugins"));
    remove_managed_entry(&managed_home.join(".claude.json"));
    fs::create_dir_all(claude_dir.join("skills")).map_err(|error| error.to_string())?;
    prune_legacy_credential_entries(&managed_home);

    let source_settings = read_json_object(&operator_home.join(".claude/settings.json"));
    let source_env = source_settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let settings_env = source_env
        .into_iter()
        .filter(|(key, value)| {
            (key.starts_with("ANTHROPIC_") || key.starts_with("DEEPSEEK_"))
                && value.as_str().is_some_and(|value| !value.trim().is_empty())
        })
        .collect::<Map<_, _>>();
    let settings = if settings_env.is_empty() {
        json!({})
    } else {
        json!({"env": settings_env})
    };
    let settings_path = claude_dir.join("settings.json");
    write_private_json(&settings_path, &settings)?;
    let mcp_path = claude_dir.join("rudder-mcp.json");
    let mcp_binary = native_mcp_server_binary()?;
    write_private_json(&mcp_path, &claude_probe_mcp_config(&mcp_binary))?;
    for relative in [".config/claude", ".config/anthropic", ".anthropic"] {
        let source = operator_home.join(relative);
        if source.exists() {
            symlink_entry(&source, &managed_home.join(relative))?;
        }
    }

    let additions = [
        (
            "HOME".to_owned(),
            operator_home.to_string_lossy().into_owned(),
        ),
        (
            "USERPROFILE".to_owned(),
            operator_home.to_string_lossy().into_owned(),
        ),
        (
            "CLAUDE_CONFIG_DIR".to_owned(),
            claude_dir.to_string_lossy().into_owned(),
        ),
        (
            "RUDDER_CLAUDE_HOME".to_owned(),
            managed_home.to_string_lossy().into_owned(),
        ),
        (
            "RUDDER_OPERATOR_HOME".to_owned(),
            operator_home.to_string_lossy().into_owned(),
        ),
    ];
    Ok((managed_home, config_with_env(config, additions, PROTECTED)))
}

fn claude_probe_mcp_config(mcp_binary: &Path) -> Value {
    json!({
        "mcpServers": {
            "rudder-tools": {
                "type": "stdio",
                "command": mcp_binary.to_string_lossy(),
                "args": ["mcp-server"]
            }
        }
    })
}

fn prepare_pi_probe_environment(
    org_id: &str,
    config: &Value,
    configured_model: &str,
) -> Result<(PathBuf, Value), String> {
    const PROTECTED: &[&str] = &[
        "AGENT_HOME",
        "HOME",
        "RUDDER_API_URL",
        "RUDDER_API_KEY",
        "RUDDER_ORG_ID",
        "RUDDER_AGENT_ID",
        "RUDDER_RUN_ID",
        "RUDDER_BROWSER_ENABLED",
        "RUDDER_COMPUTER_ENABLED",
        "RUDDER_PROJECT_LIBRARY_PATH",
        "RUDDER_DESKTOP_CLI_ENTRY",
        "RUDDER_AGENT_ROOT",
        "RUDDER_OPERATOR_HOME",
        "USERPROFILE",
    ];
    let operator_home = home_directory(config, false);
    let managed_home = managed_runtime_home(config, org_id, "pi-home")?;
    let source_pi = operator_home.join(".pi");
    let target_pi = managed_home.join(".pi");
    let target_agent = target_pi.join("agent");
    fs::create_dir_all(target_agent.join("skills")).map_err(|error| error.to_string())?;
    fs::create_dir_all(target_pi.join("paperclips")).map_err(|error| error.to_string())?;
    prune_legacy_credential_entries(&managed_home);
    sync_pi_home_entries(&source_pi, &target_pi)?;

    let mut additions = vec![
        (
            "HOME".to_owned(),
            operator_home.to_string_lossy().into_owned(),
        ),
        (
            "USERPROFILE".to_owned(),
            operator_home.to_string_lossy().into_owned(),
        ),
        (
            "RUDDER_OPERATOR_HOME".to_owned(),
            operator_home.to_string_lossy().into_owned(),
        ),
    ];
    if !configured_model.is_empty() {
        prepare_pi_opencode_anonymous_config(
            config,
            configured_model,
            &target_agent,
            &operator_home,
            &additions,
        )?;
        additions.push((
            "PI_CODING_AGENT_DIR".to_owned(),
            target_agent.to_string_lossy().into_owned(),
        ));
    }
    Ok((managed_home, config_with_env(config, additions, PROTECTED)))
}

fn sync_pi_home_entries(source_pi: &Path, target_pi: &Path) -> Result<(), String> {
    if !source_pi.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source_pi).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if name == "agent" || name == "paperclips" {
            continue;
        }
        symlink_entry(&entry.path(), &target_pi.join(name))?;
    }
    let source_agent = source_pi.join("agent");
    if source_agent.is_dir() {
        let target_agent = target_pi.join("agent");
        fs::create_dir_all(&target_agent).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source_agent).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if name == "skills" {
                continue;
            }
            symlink_entry(&entry.path(), &target_agent.join(name))?;
        }
    }
    Ok(())
}

fn prepare_pi_opencode_anonymous_config(
    config: &Value,
    model: &str,
    target_agent: &Path,
    operator_home: &Path,
    additions: &[(String, String)],
) -> Result<(), String> {
    let Some((provider, model_id)) = model.split_once('/') else {
        return Ok(());
    };
    if provider != "opencode" || !(model_id == "big-pickle" || model_id.ends_with("-free")) {
        return Ok(());
    }
    let explicit_key = env_value_or_host(config, "OPENCODE_API_KEY")
        .or_else(|| {
            additions
                .iter()
                .find(|(key, _)| key == "OPENCODE_API_KEY")
                .map(|(_, v)| v.clone())
        })
        .or_else(|| env::var("OPENCODE_API_KEY").ok())
        .is_some_and(|value| !value.trim().is_empty());
    if explicit_key {
        return Ok(());
    }
    fs::create_dir_all(target_agent).map_err(|error| error.to_string())?;
    let models_path = target_agent.join("models.json");
    if fs::symlink_metadata(&models_path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        fs::remove_file(&models_path).map_err(|error| error.to_string())?;
    }
    let mut root = read_json_object(&models_path);
    let mut providers = root
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut opencode = providers
        .get("opencode")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut headers = opencode
        .get("headers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    opencode
        .entry("apiKey".to_owned())
        .or_insert_with(|| json!("RUDDER_OPENCODE_ANONYMOUS"));
    opencode.insert("authHeader".to_owned(), Value::Bool(false));
    headers.insert("Authorization".to_owned(), json!(""));
    opencode.insert("headers".to_owned(), Value::Object(headers));
    providers.insert("opencode".to_owned(), Value::Object(opencode));
    root.insert("providers".to_owned(), Value::Object(providers));
    write_private_json(&models_path, &Value::Object(root))?;

    let settings_path = target_agent.join("settings.json");
    if fs::symlink_metadata(&settings_path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        fs::remove_file(settings_path).map_err(|error| error.to_string())?;
    }
    let _ = operator_home;
    Ok(())
}

fn remove_managed_entry(path: &Path) {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || metadata.is_file() {
            let _ = fs::remove_file(path);
        } else if metadata.is_dir() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn prune_legacy_credential_entries(home: &Path) {
    const ENTRIES: &[&str] = &[
        ".aws",
        ".azure",
        ".config/gh",
        ".config/gcloud",
        ".config/op",
        ".config/vercel",
        ".config/configstore",
        ".docker",
        ".fly",
        ".git-credentials",
        ".gnupg",
        ".kube",
        ".netrc",
        ".npm",
        ".vscode",
    ];
    for relative in ENTRIES {
        let path = home.join(relative);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || (metadata.is_file() && metadata.len() == 0) {
            let _ = fs::remove_file(path);
        } else if metadata.is_dir()
            && fs::read_dir(&path).is_ok_and(|mut entries| entries.next().is_none())
        {
            let _ = fs::remove_dir(path);
        }
    }
}

fn config_strings(config: &Value) -> Vec<String> {
    config
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn env_strings(config: &Value) -> Vec<(String, String)> {
    config
        .get("env")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|values| values.iter())
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect()
}

fn path_env(config: &Value) -> String {
    #[cfg(windows)]
    let configured_path = env_strings(config)
        .into_iter()
        .find_map(|(key, value)| key.eq_ignore_ascii_case("PATH").then_some(value));
    #[cfg(not(windows))]
    let configured_path = env_strings(config)
        .into_iter()
        .find_map(|(key, value)| (key == "PATH").then_some(value));

    let host_path = env::var("PATH").ok().filter(|value| !value.is_empty());
    #[cfg(windows)]
    let host_path = host_path.or(env::var("Path").ok().filter(|value| !value.is_empty()));
    match configured_path {
        Some(value) if !value.is_empty() => value,
        Some(_) => default_path(),
        None => host_path.unwrap_or_else(default_path),
    }
}

fn default_path() -> String {
    #[cfg(windows)]
    {
        "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem".to_owned()
    }
    #[cfg(not(windows))]
    {
        "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin".to_owned()
    }
}

fn resolve_command(command: &str, cwd: &Path, config: &Value) -> Option<PathBuf> {
    if command.trim().is_empty() {
        return None;
    }
    let command_path = Path::new(command);
    if command_path.is_absolute() || command.contains('/') || command.contains('\\') {
        let candidate = if command_path.is_absolute() {
            command_path.to_path_buf()
        } else {
            cwd.join(command_path)
        };
        return executable_file(&candidate).then_some(candidate);
    }
    for directory in env::split_paths(OsStr::new(&path_env(config))) {
        let candidate = directory.join(command);
        if executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        for extension in command_path_extensions(config) {
            let candidate = directory.join(format!("{command}{extension}"));
            if executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // Node's resolver checks access(X_OK) and does not additionally require
        // a regular file; keep the same preflight boundary before CLI spawn.
        unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(windows)]
    {
        std::fs::metadata(path).is_ok()
    }
}

#[cfg(windows)]
fn command_path_extensions(config: &Value) -> Vec<String> {
    config
        .get("env")
        .and_then(Value::as_object)
        .and_then(|env| env.get("PATHEXT"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| env::var("PATHEXT").ok())
        .unwrap_or_else(|| ".EXE;.CMD;.BAT;.COM".to_owned())
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(str::to_owned)
        .collect()
}

fn cwd(config: &Value) -> PathBuf {
    let value = config_string(config, "cwd", "");
    if value.is_empty() {
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(value)
    }
}

fn ensure_cwd(path: &Path, create_if_missing: bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "Working directory must be an absolute path: \"{}\"",
            path.display()
        ));
    }
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "Working directory is not a directory: \"{}\"",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_if_missing => {
            fs::create_dir_all(path).map_err(|error| {
                format!(
                    "Could not create working directory \"{}\": {error}",
                    path.display()
                )
            })?;
            match fs::metadata(path) {
                Ok(metadata) if metadata.is_dir() => Ok(()),
                Ok(_) => Err(format!(
                    "Working directory is not a directory: \"{}\"",
                    path.display()
                )),
                Err(error) => Err(format!(
                    "Could not create working directory \"{}\": {error}",
                    path.display()
                )),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "Working directory does not exist: \"{}\"",
            path.display()
        )),
        Err(error) => Err(error.to_string()),
    }
}

fn command_error(command: &str, cwd: &Path, config: &Value) -> Option<String> {
    if resolve_command(command, cwd, config).is_some() {
        None
    } else if command.contains('/') || command.contains('\\') {
        let absolute = if Path::new(command).is_absolute() {
            PathBuf::from(command)
        } else {
            cwd.join(command)
        };
        Some(format!(
            "Command is not executable: \"{command}\" (resolved: \"{}\")",
            absolute.display()
        ))
    } else {
        Some(format!("Command not found in PATH: \"{command}\""))
    }
}

async fn run_command(
    command: &str,
    args: &[String],
    cwd: &Path,
    config: &Value,
    stdin: Option<&str>,
    timeout_seconds: u64,
) -> Result<ProcessOutput, String> {
    let executable = resolve_command(command, cwd, config).ok_or_else(|| {
        command_error(command, cwd, config).unwrap_or_else(|| "Command unavailable".to_owned())
    })?;
    let mut process = Command::new(executable);
    process
        .args(args)
        .current_dir(cwd)
        .envs(env_strings(config))
        .env("PATH", path_env(config))
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = process.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture runtime stdout".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture runtime stderr".to_owned())?;
    let stdout_reader = tokio::spawn(read_child_output(stdout));
    let stderr_reader = tokio::spawn(read_child_output(stderr));
    let wait = async {
        if let (Some(input), Some(mut child_stdin)) = (stdin, child.stdin.take()) {
            child_stdin.write_all(input.as_bytes()).await?;
            child_stdin.shutdown().await?;
        }
        child.wait().await
    };
    let status = match timeout(Duration::from_secs(timeout_seconds.max(1)), wait).await {
        Ok(Ok(status)) => Some(status.code()),
        Ok(Err(error)) => return Err(error.to_string()),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            None
        }
    };
    let stdout = stdout_reader
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let stderr = stderr_reader
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(ProcessOutput {
        status: status.flatten(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out: status.is_none(),
    })
}

async fn read_child_output<R>(reader: R) -> Result<Vec<u8>, std::io::Error>
where
    R: tokio::io::AsyncRead + Unpin,
{
    const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
    let mut bytes = Vec::new();
    reader
        .take(MAX_OUTPUT_BYTES)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

fn blocking_warn() -> String {
    "Runtime environment returned warn status.".to_owned()
}

fn command_basename_matches(command: &str, expected: &[&str]) -> bool {
    let base = Path::new(command)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(command)
        .to_ascii_lowercase();
    expected
        .iter()
        .any(|name| base == *name || base == format!("{name}.cmd") || base == format!("{name}.exe"))
}

fn contains_hello(text: &str) -> bool {
    text.to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|word| word == "hello")
}

fn json_lines(stdout: &str) -> impl Iterator<Item = Value> + '_ {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn claude_summary(output: &ProcessOutput) -> (String, String) {
    let mut assistant_texts = Vec::new();
    let mut result_text = String::new();
    let mut errors = Vec::new();
    for event in json_lines(&output.stdout) {
        match string_field(&event, "type") {
            "assistant" => {
                if let Some(content) = event
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in content {
                        if string_field(block, "type") == "text"
                            && let Some(text) = block.get("text").and_then(Value::as_str)
                        {
                            assistant_texts.push(text.to_owned());
                        }
                    }
                }
            }
            "result" => {
                result_text = string_field(&event, "result").trim().to_owned();
                if let Some(values) = event.get("errors").and_then(Value::as_array) {
                    for value in values {
                        let message = if let Some(message) = value.as_str() {
                            message.to_owned()
                        } else {
                            string_field(value, "message").to_owned()
                        };
                        if !message.trim().is_empty() {
                            errors.push(message);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let summary = if result_text.is_empty() {
        assistant_texts.join("\n\n")
    } else {
        result_text
    };
    (summary, errors.join("\n"))
}

fn codex_summary(output: &ProcessOutput) -> (String, String) {
    let mut messages = Vec::new();
    let mut terminal_result = String::new();
    let mut terminal_completed = false;
    let mut errors = Vec::new();
    for event in json_lines(&output.stdout) {
        match string_field(&event, "type") {
            "item.completed" => {
                let item = event.get("item").unwrap_or(&Value::Null);
                if string_field(item, "type") == "agent_message" {
                    let text = string_field(item, "text");
                    if !text.is_empty() {
                        messages.push(text.to_owned());
                    }
                }
            }
            "turn.completed" => {
                terminal_completed = true;
                terminal_result = string_field(&event, "result").to_owned();
            }
            "error" => {
                let message = string_field(&event, "message");
                if !message.is_empty() {
                    errors.push(message.to_owned());
                }
            }
            "turn.failed" => {
                let message = event
                    .get("error")
                    .map(|error| string_field(error, "message"))
                    .unwrap_or_default();
                if !message.is_empty() {
                    errors.push(message.to_owned());
                }
            }
            _ => {}
        }
    }
    let summary = if terminal_completed {
        let messages = messages.join("\n\n").trim().to_owned();
        if messages.is_empty() {
            terminal_result.trim().to_owned()
        } else {
            messages
        }
    } else {
        String::new()
    };
    (summary, errors.join("\n"))
}

fn opencode_summary(output: &ProcessOutput) -> (String, String) {
    let mut messages = Vec::new();
    let mut errors = Vec::new();
    for event in json_lines(&output.stdout) {
        if string_field(&event, "type") == "text"
            && let Some(text) = event
                .get("part")
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
        {
            messages.push(text.trim().to_owned());
        }
        if string_field(&event, "type") == "error" {
            let err = event.get("error").unwrap_or(&Value::Null);
            let message = err
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    err.get("message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .or_else(|| {
                    event
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            if !message.is_empty() {
                errors.push(message);
            }
        }
    }
    (messages.join("\n\n").trim().to_owned(), errors.join("\n"))
}

fn pi_summary(output: &ProcessOutput) -> (String, String) {
    let mut messages = Vec::new();
    let mut final_message = String::new();
    let mut errors = Vec::new();
    for event in json_lines(&output.stdout) {
        let event_type = string_field(&event, "type");
        if event_type == "agent_end"
            && let Some(items) = event.get("messages").and_then(Value::as_array)
            && let Some(last) = items.last()
            && string_field(last, "role") == "assistant"
        {
            final_message = json_content_text(last.get("content").unwrap_or(&Value::Null));
        }
        if event_type == "turn_end" {
            let message = event.get("message").unwrap_or(&Value::Null);
            let text = json_content_text(message.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                final_message = text.clone();
                messages.push(text);
            }
            if string_field(message, "stopReason") == "error" {
                let error = string_field(message, "errorMessage");
                if !error.is_empty() {
                    errors.push(error.to_owned());
                }
            }
        }
        if event_type == "message_update"
            && let Some(delta) = event
                .get("assistantMessageEvent")
                .filter(|entry| string_field(entry, "type") == "text_delta")
                .map(|entry| string_field(entry, "delta"))
            && !delta.is_empty()
        {
            if let Some(last) = messages.last_mut() {
                last.push_str(delta);
            } else {
                messages.push(delta.to_owned());
            }
        }
    }
    let summary = if final_message.is_empty() {
        messages.join("\n\n").trim().to_owned()
    } else {
        final_message
    };
    (summary, errors.join("\n"))
}

fn json_content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| matches!(string_field(block, "type"), "text" | "output_text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn cursor_summary(output: &ProcessOutput) -> (String, String) {
    let mut messages = Vec::new();
    let mut errors = Vec::new();
    for event in json_lines(&output.stdout) {
        match string_field(&event, "type") {
            "assistant" => {
                if let Some(message) = event.get("message") {
                    let text = string_field(message, "text");
                    if !text.trim().is_empty() {
                        messages.push(text.trim().to_owned());
                    }
                    if let Some(content) = message.get("content").and_then(Value::as_array) {
                        messages.extend(content.iter().filter_map(|part| {
                            matches!(string_field(part, "type"), "text" | "output_text")
                                .then(|| string_field(part, "text").trim().to_owned())
                                .filter(|text| !text.is_empty())
                        }));
                    }
                }
            }
            "result" | "error" | "system" => {
                let subtype_error = string_field(&event, "subtype") == "error";
                if event_type_is_error(&event) || subtype_error {
                    let value = event
                        .get("error")
                        .or_else(|| event.get("message"))
                        .or_else(|| event.get("detail"))
                        .unwrap_or(&Value::Null);
                    let text = value
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| {
                            value
                                .get("message")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .unwrap_or_default();
                    if !text.is_empty() {
                        errors.push(text);
                    }
                }
                if string_field(&event, "type") == "result"
                    && messages.is_empty()
                    && !string_field(&event, "result").trim().is_empty()
                {
                    messages.push(string_field(&event, "result").trim().to_owned());
                }
            }
            _ => {}
        }
    }
    (messages.join("\n\n").trim().to_owned(), errors.join("\n"))
}

fn event_type_is_error(value: &Value) -> bool {
    string_field(value, "type") == "error"
}

async fn test_claude(org_id: &str, config: &Value) -> Result<Option<String>, String> {
    let command = config_string(config, "command", "claude");
    let cwd = cwd(config);
    if let Err(error) = ensure_cwd(&cwd, true) {
        return Ok(Some(error));
    }
    let (managed_home, probe_config) = prepare_claude_probe_environment(org_id, config)?;
    if let Some(error) = command_error(&command, &cwd, &probe_config) {
        return Ok(Some(error));
    }
    let mut warned = env_nonempty(&probe_config, "ANTHROPIC_API_KEY").is_some();
    let model = config_string(config, "model", "");
    if model.to_ascii_lowercase().starts_with("deepseek")
        && env_nonempty(&probe_config, "DEEPSEEK_API_KEY").is_none()
    {
        warned = true;
    }
    if !command_basename_matches(&command, &["claude"]) {
        return Ok(warned.then(blocking_warn));
    }
    let mut args = vec![
        "--print".into(),
        "-".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    let dangerously_skip_permissions = config
        .get("dangerouslySkipPermissions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if dangerously_skip_permissions {
        args.push("--dangerously-skip-permissions".into());
    } else {
        let permission_mode = nonempty(config, "permissionMode")
            .filter(|mode| {
                ["acceptEdits", "auto", "default", "dontAsk", "plan"].contains(&mode.as_str())
            })
            .unwrap_or_else(|| "auto".to_owned());
        args.extend(["--permission-mode".into(), permission_mode]);
    }
    if config.get("chrome") == Some(&Value::Bool(true)) {
        args.push("--chrome".into());
    }
    if let Some(model) = nonempty(config, "model") {
        args.extend(["--model".into(), model]);
    }
    if let Some(effort) = nonempty(config, "effort") {
        args.extend(["--effort".into(), effort]);
    }
    if let Some(max_turns) = config
        .get("maxTurnsPerRun")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
    {
        args.extend(["--max-turns".into(), max_turns.to_string()]);
    }
    let managed_home_path = managed_home.join(".claude");
    args.extend([
        "--settings".into(),
        managed_home_path
            .join("settings.json")
            .to_string_lossy()
            .into_owned(),
        "--setting-sources".into(),
        "user".into(),
        "--mcp-config".into(),
        managed_home_path
            .join("rudder-mcp.json")
            .to_string_lossy()
            .into_owned(),
        "--strict-mcp-config".into(),
    ]);
    let args = append_sanitized_claude_args(config, args);
    let output = run_command(
        &command,
        &args,
        &cwd,
        &probe_config,
        Some("Respond with hello."),
        45,
    )
    .await?;
    let (summary, parsed_errors) = claude_summary(&output);
    let evidence =
        format!("{parsed_errors}\n{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if claude_auth_required(&evidence) {
        warned = true;
    } else if contains_hello(&summary) && (output.status == Some(0) || output.timed_out) {
        warned |= output.timed_out;
    } else if output.timed_out || output.status == Some(0) {
        warned = true;
    } else {
        return Ok(Some("Claude hello probe failed.".to_owned()));
    }
    Ok(warned.then(blocking_warn))
}

async fn test_codex(org_id: &str, config: &Value) -> Result<Option<String>, String> {
    let command = config_string(config, "command", "codex");
    let cwd = cwd(config);
    if let Err(error) = ensure_cwd(&cwd, true) {
        return Ok(Some(error));
    }
    if let Some(error) = command_error(&command, &cwd, config) {
        return Ok(Some(error));
    }
    if !command_basename_matches(&command, &["codex"]) {
        return Ok(None);
    }
    let (_, probe_config) = prepare_codex_home(org_id, config)?;
    let args = codex_probe_args(config);
    let seconds = config
        .get("helloProbeTimeoutSec")
        .and_then(Value::as_u64)
        .unwrap_or(180)
        .max(1);
    let mut args = args;
    args.push("-".into());
    let output = run_command(
        &command,
        &args,
        &cwd,
        &probe_config,
        Some("Respond with hello."),
        seconds,
    )
    .await?;
    let (summary, parsed_error) = codex_summary(&output);
    let evidence =
        format!("{parsed_error}\n{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if output.timed_out {
        Ok(Some(blocking_warn()))
    } else if output.status == Some(0) {
        Ok((!contains_hello(&summary)).then(blocking_warn))
    } else if [
        "not logged in",
        "login required",
        "authentication required",
        "unauthorized",
        "invalid api key",
        "api key required",
        "api_key_required",
    ]
    .iter()
    .any(|pattern| evidence.contains(pattern))
    {
        Ok(Some(blocking_warn()))
    } else {
        Ok(Some("Codex hello probe failed.".to_owned()))
    }
}

fn codex_probe_args(config: &Value) -> Vec<String> {
    let mut args = vec![
        "exec".into(),
        "--json".into(),
        "--disable".into(),
        "plugins".into(),
    ];
    if config.get("search") == Some(&Value::Bool(true)) {
        args.insert(0, "--search".into());
    }
    let bypass = config
        .get("dangerouslyBypassApprovalsAndSandbox")
        .and_then(Value::as_bool)
        .or_else(|| {
            config
                .get("dangerouslyBypassSandbox")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
    if bypass {
        args.push("--dangerously-bypass-approvals-and-sandbox".into());
    }
    let model = nonempty(config, "model").unwrap_or_else(|| "gpt-5.6-luna".to_owned());
    args.extend(["--model".into(), model]);
    let effort = nonempty(config, "modelReasoningEffort")
        .or_else(|| nonempty(config, "reasoningEffort"))
        .unwrap_or_else(|| "medium".to_owned());
    args.extend(["-c".into(), format!("model_reasoning_effort={effort:?}")]);
    append_extra_args(config, args)
}

async fn test_opencode(config: &Value) -> Result<Option<String>, String> {
    let command = config_string(config, "command", "opencode");
    let cwd = cwd(config);
    if let Err(error) = ensure_cwd(&cwd, false) {
        return Ok(Some(error));
    }
    if let Some(error) = command_error(&command, &cwd, config) {
        return Ok(Some(error));
    }
    let mut warned = config
        .get("env")
        .and_then(|env| env.get("OPENAI_API_KEY"))
        .and_then(Value::as_str)
        .is_some_and(|value| value.trim().is_empty());

    // Node's model list is diagnostic. It is still run before model validation
    // and the hello probe, and any warning blocks first-Agent seeding even if
    // the later probe succeeds.
    let discovery = run_command(
        &command,
        &["models".to_owned(), "--verbose".to_owned()],
        &cwd,
        config,
        None,
        20,
    )
    .await;
    let discovery_warning = match discovery {
        Ok(output) if !output.timed_out && output.status == Some(0) => {
            opencode_model_ids(&output.stdout).is_empty()
        }
        _ => true,
    };
    warned |= discovery_warning;
    let model = nonempty(config, "model").unwrap_or_default();
    if !provider_model_format(&model) {
        return Ok(Some(
            "OpenCode requires a configured model in provider/model format.".to_owned(),
        ));
    }
    let mut args = vec![
        "run".into(),
        "--format".into(),
        "json".into(),
        "--model".into(),
        model,
    ];
    if let Some(variant) = nonempty(config, "variant") {
        args.extend(["--variant".into(), variant]);
    }
    let args = append_extra_args(config, args);
    let output = run_command(
        &command,
        &args,
        &cwd,
        config,
        Some("Respond with hello."),
        60,
    )
    .await?;
    let (summary, parsed_error) = opencode_summary(&output);
    let evidence =
        format!("{parsed_error}\n{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if output.timed_out {
        warned = true;
    } else if output.status == Some(0) {
        if !contains_hello(&summary) {
            warned = true;
        }
    } else if [
        "authentication required",
        "api key",
        "invalid api key",
        "not logged in",
        "opencode auth login",
        "free usage exceeded",
        "providermodelnotfounderror",
        "model not found",
    ]
    .iter()
    .any(|pattern| evidence.contains(pattern))
    {
        warned = true;
    } else {
        return Ok(Some("OpenCode hello probe failed.".to_owned()));
    }
    Ok(warned.then(blocking_warn))
}

async fn test_pi(org_id: &str, config: &Value) -> Result<Option<String>, String> {
    let command = config_string(config, "command", "pi");
    let cwd = cwd(config);
    if let Err(error) = ensure_cwd(&cwd, false) {
        return Ok(Some(error));
    }
    let configured_model = nonempty(config, "model").unwrap_or_default();
    let (_, probe_config) = prepare_pi_probe_environment(org_id, config, &configured_model)?;
    if let Some(error) = command_error(&command, &cwd, &probe_config) {
        return Ok(Some(error));
    }
    let discovery = run_command(
        &command,
        &["--list-models".to_owned()],
        &cwd,
        &probe_config,
        None,
        20,
    )
    .await;
    let discovery_warning = match discovery {
        Ok(output) if !output.timed_out && output.status == Some(0) => {
            pi_model_ids(&format!("{}\n{}", output.stdout, output.stderr)).is_empty()
        }
        _ => true,
    };
    if !provider_model_format(&configured_model) {
        return Ok(Some(
            "Pi requires a configured model in provider/model format.".to_owned(),
        ));
    }
    let (provider, model_id) = configured_model
        .split_once('/')
        .unwrap_or(("", configured_model.as_str()));
    let mut warned = discovery_warning;
    let mut args = vec![
        "-p".into(),
        "Respond with hello.".into(),
        "--mode".into(),
        "json".into(),
    ];
    args.extend([
        "--provider".into(),
        provider.to_owned(),
        "--model".into(),
        model_id.to_owned(),
    ]);
    if let Some(thinking) = nonempty(config, "thinking") {
        args.extend(["--thinking".into(), thinking]);
    }
    args.extend(["--tools".into(), "read".into()]);
    let args = append_extra_args(config, args);
    let output = run_command(&command, &args, &cwd, &probe_config, None, 60).await?;
    let (summary, parsed_errors) = pi_summary(&output);
    let evidence =
        format!("{parsed_errors}\n{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if output.timed_out {
        warned = true;
    } else if output.status == Some(0) && parsed_errors.is_empty() {
        if !contains_hello(&summary) {
            warned = true;
        }
    } else if [
        "authentication required",
        "api key",
        "invalid api key",
        "not logged in",
        "free usage exceeded",
        "membership benefits",
        "membership is active",
        "401",
        "unauthorized",
    ]
    .iter()
    .any(|pattern| evidence.contains(pattern))
    {
        warned = true;
    } else {
        return Ok(Some("Pi hello probe failed.".to_owned()));
    }
    Ok(warned.then(blocking_warn))
}

async fn test_cursor(config: &Value) -> Result<Option<String>, String> {
    let command = config_string(config, "command", "cursor-agent");
    let cwd = cwd(config);
    if let Err(error) = ensure_cwd(&cwd, true) {
        return Ok(Some(error));
    }
    if let Some(error) = command_error(&command, &cwd, config) {
        return Ok(Some(error));
    }
    let mut warned = env_nonempty(config, "CURSOR_API_KEY").is_none();
    if !command_basename_matches(&command, &["cursor-agent", "agent"]) {
        return Ok(warned.then(blocking_warn));
    }
    let extra_args = extra_args(config);
    let auto_trust_enabled = !extra_args.iter().any(|arg| {
        arg == "--trust" || arg == "--yolo" || arg == "-f" || arg.starts_with("--trust=")
    });
    let mut args = vec![
        "-p".into(),
        "--mode".into(),
        "ask".into(),
        "--output-format".into(),
        "json".into(),
        "--workspace".into(),
        cwd.to_string_lossy().into_owned(),
    ];
    let model = nonempty(config, "model").unwrap_or_else(|| "auto".to_owned());
    let model = apply_cursor_effort(&model, nonempty(config, "effort").as_deref());
    if !model.is_empty() {
        args.extend(["--model".into(), model]);
    }
    if auto_trust_enabled {
        args.push("--yolo".into());
    }
    args.extend(extra_args);
    args.push("Respond with hello.".into());
    let seconds = config
        .get("helloProbeTimeoutSec")
        .and_then(Value::as_u64)
        .unwrap_or(90)
        .max(1);
    let output = run_command(&command, &args, &cwd, config, None, seconds).await?;
    let (summary, parsed_error) = cursor_summary(&output);
    let evidence =
        format!("{parsed_error}\n{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if output.timed_out {
        warned = true;
    } else if output.status == Some(0) {
        warned |= !contains_hello(&summary);
    } else if [
        "authentication required",
        "not authenticated",
        "not logged in",
        "unauthorized",
        "invalid api key",
        "cursor_api_key",
        "api key required",
        "run 'agent login' first",
        "usage limit",
        "get cursor pro",
        "quota",
        "rate limit",
        "too many requests",
        "429",
        "billing",
    ]
    .iter()
    .any(|pattern| evidence.contains(pattern))
    {
        warned = true;
    } else {
        return Ok(Some("Cursor hello probe failed.".to_owned()));
    }
    Ok(warned.then(blocking_warn))
}

fn extra_args(config: &Value) -> Vec<String> {
    let from_extra = config_strings(config.get("extraArgs").unwrap_or(&Value::Null));
    if from_extra.is_empty() {
        config_strings(config.get("args").unwrap_or(&Value::Null))
    } else {
        from_extra
    }
}

fn apply_cursor_effort(model: &str, effort: Option<&str>) -> String {
    let model = model.trim();
    if model.is_empty() {
        return String::new();
    }
    let (base, raw_params) = model
        .find('[')
        .map(|index| {
            let raw = if model.ends_with(']') {
                &model[index + 1..model.len() - 1]
            } else {
                ""
            };
            (&model[..index], raw)
        })
        .unwrap_or((model, ""));
    let mut params = raw_params
        .split(',')
        .map(str::trim)
        .filter(|parameter| {
            !parameter.is_empty()
                && !parameter
                    .split_once('=')
                    .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("effort"))
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(effort) = effort
        .map(str::trim)
        .filter(|effort| !effort.is_empty() && !effort.eq_ignore_ascii_case("auto"))
    {
        params.push(format!("effort={}", effort.to_ascii_lowercase()));
    }
    if params.is_empty() {
        base.to_owned()
    } else {
        format!("{base}[{}]", params.join(","))
    }
}

fn claude_auth_required(evidence: &str) -> bool {
    evidence.to_ascii_lowercase().lines().any(|line| {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        line.contains("not logged in")
            || line.contains("please log in")
            || line.contains("login required")
            || line.contains("requires login")
            || line.contains("unauthorized")
            || line.contains("authentication required")
            || line.split("please run").skip(1).any(|tail| {
                let tail = tail.trim_start().trim_start_matches('`');
                [
                    "login",
                    "claude login",
                    "auth login",
                    "claude auth login",
                    "/login",
                ]
                .iter()
                .any(|pattern| tail.starts_with(pattern))
            })
    })
}

fn nonempty(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn provider_model_format(model: &str) -> bool {
    let Some((provider, model)) = model.split_once('/') else {
        return false;
    };
    !provider.trim().is_empty() && !model.trim().is_empty()
}

fn opencode_model_ids(stdout: &str) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let first = line.split_whitespace().next().unwrap_or_default();
        if let Some((provider, model)) = first.split_once('/')
            && !provider.trim().is_empty()
            && !model.trim().is_empty()
        {
            ids.insert(format!("{}/{}", provider.trim(), model.trim()));
        }
    }
    ids.into_iter().collect()
}

fn pi_model_ids(output: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let mut columns = line.split_whitespace();
        let Some(provider) = columns.next() else {
            continue;
        };
        let Some(model) = columns.next() else {
            continue;
        };
        if provider == "provider" && model == "model" {
            continue;
        }
        ids.push(format!("{provider}/{model}"));
    }
    ids
}

fn append_sanitized_claude_args(config: &Value, mut args: Vec<String>) -> Vec<String> {
    const VALUE_FLAGS: &[&str] = &[
        "--add-dir",
        "--allowedTools",
        "--allowed-tools",
        "--disallowedTools",
        "--disallowed-tools",
        "--mcp-config",
        "--permission-mode",
        "--plugin-dir",
        "--plugin-url",
        "--setting-sources",
        "--settings",
        "--tools",
    ];
    const STANDALONE_FLAGS: &[&str] = &[
        "--allow-dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "--no-strict-mcp-config",
        "--strict-mcp-config",
    ];
    let mut extra = extra_args(config).into_iter();
    while let Some(argument) = extra.next() {
        if argument == "--permission-mode" || VALUE_FLAGS.contains(&argument.as_str()) {
            let _ = extra.next();
            continue;
        }
        if STANDALONE_FLAGS.contains(&argument.as_str())
            || argument.starts_with("--permission-mode=")
            || [
                "--add-dir=",
                "--allowedTools=",
                "--allowed-tools=",
                "--disallowedTools=",
                "--disallowed-tools=",
                "--mcp-config=",
                "--permission-mode=",
                "--plugin-dir=",
                "--plugin-url=",
                "--setting-sources=",
                "--settings=",
                "--strict-mcp-config=",
                "--tools=",
            ]
            .iter()
            .any(|prefix| argument.starts_with(prefix))
        {
            continue;
        }
        args.push(argument);
    }
    args
}

fn append_extra_args(config: &Value, mut args: Vec<String>) -> Vec<String> {
    let extra = config_strings(config.get("extraArgs").unwrap_or(&Value::Null));
    let extra = if extra.is_empty() {
        config_strings(config.get("args").unwrap_or(&Value::Null))
    } else {
        extra
    };
    args.extend(extra);
    args
}

async fn test_openclaw_gateway(config: &Value) -> Result<Option<String>, String> {
    let raw_url = config_string(config, "url", "");
    let raw_url = raw_url.trim();
    if raw_url.is_empty() {
        return Ok(Some(
            "OpenClaw gateway adapter requires a WebSocket URL.".to_owned(),
        ));
    }
    let url = match url::Url::parse(raw_url) {
        Ok(url) => url,
        Err(_) => return Ok(Some(format!("Invalid URL: {raw_url}"))),
    };
    if !matches!(url.scheme(), "ws" | "wss") {
        return Ok(Some(format!("Unsupported URL protocol: {}", url.scheme())));
    }
    let mut warned = url.scheme() == "ws" && !loopback_host(url.host_str().unwrap_or_default());
    let mut headers = config
        .get("headers")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|headers| headers.iter())
        .filter_map(|(key, value)| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(|value| (key.clone(), value.to_owned()))
        })
        .collect::<Vec<_>>();
    let auth_token = nonempty(config, "authToken")
        .or_else(|| nonempty(config, "token"))
        .or_else(|| header_ci(&headers, "x-openclaw-token"))
        .or_else(|| {
            header_ci(&headers, "x-openclaw-auth")
                .or_else(|| header_ci(&headers, "authorization"))
                .map(|header| {
                    let trimmed = header.trim();
                    if trimmed.to_ascii_lowercase().starts_with("bearer ") {
                        trimmed[7..].trim().to_owned()
                    } else {
                        trimmed.to_owned()
                    }
                })
        })
        .filter(|value| !value.trim().is_empty());
    warned |= auth_token.is_none() && nonempty(config, "password").is_none();
    if let Some(auth_token) = &auth_token
        && !headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("x-openclaw-token"))
    {
        headers.push(("x-openclaw-token".to_owned(), auth_token.clone()));
    }
    let mut scopes = match config.get("scopes") {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>(),
        Some(Value::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    if scopes.is_empty() {
        scopes = vec!["operator.read".into(), "operator.write".into()];
    }
    let connect_id = "rudder-agent-create-probe";
    let client = awc::ClientBuilder::new()
        .timeout(Duration::from_secs(3))
        .disable_redirects()
        .no_default_headers()
        .finish();
    let mut request = client.ws(url.as_str()).max_frame_size(2 * 1024 * 1024);
    for (key, value) in headers {
        request = request.set_header(key, value);
    }
    let connected = match timeout(Duration::from_secs(3), request.connect()).await {
        Ok(Ok((_, socket))) => socket,
        _ => return Ok(Some(blocking_warn())),
    };
    let mut socket = connected;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(Some(blocking_warn()));
        }
        let frame = match timeout(remaining, socket.next()).await {
            Ok(Some(Ok(frame))) => frame,
            _ => return Ok(Some(blocking_warn())),
        };
        let awc::ws::Frame::Text(text) = frame else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&text) else {
            continue;
        };
        if value["type"] == "event" && value["event"] == "connect.challenge" {
            let Some(_nonce) = value["payload"]["nonce"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
            else {
                return Ok(Some(blocking_warn()));
            };
            let payload = openclaw_connect_payload(
                connect_id,
                std::env::consts::OS,
                &nonempty(config, "role").unwrap_or_else(|| "operator".to_owned()),
                &scopes,
                auth_token.as_deref(),
            );
            let text = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
            if socket
                .send(awc::ws::Message::Text(text.into()))
                .await
                .is_err()
            {
                return Ok(Some(blocking_warn()));
            }
        } else if value["type"] == "res" {
            return if value["ok"] == true {
                Ok(warned.then(blocking_warn))
            } else {
                Ok(Some(blocking_warn()))
            };
        }
    }
}

fn openclaw_connect_payload(
    connect_id: &str,
    platform: &str,
    role: &str,
    scopes: &[String],
    auth_token: Option<&str>,
) -> Value {
    let mut params = json!({
        "minProtocol": 4,
        "maxProtocol": 4,
        "client": {
            "id": "gateway-client",
            "version": "rudder-probe",
            "platform": platform,
            "mode": "probe"
        },
        "role": role,
        "scopes": scopes,
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    if let Some(token) = auth_token {
        params.insert("auth".to_owned(), json!({"token": token}));
    }
    json!({"type":"req","id":connect_id,"method":"connect","params":params})
}

async fn test_hermes_gateway(config: &Value) -> Result<Option<String>, String> {
    let configured = config_string(config, "url", "");
    let base_text = configured.trim().trim_end_matches('/');
    if base_text.is_empty() {
        return Ok(Some("Hermes API Server URL is required.".to_owned()));
    }
    let base = match url::Url::parse(base_text) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => return Ok(Some(
            "Hermes URL must be an http(s) loopback endpoint without userinfo, query, or fragment."
                .to_owned(),
        )),
    };
    if base.username() != ""
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || !loopback_host(base.host_str().unwrap_or_default())
    {
        return Ok(Some(
            "Hermes URL must be an http(s) loopback endpoint without userinfo, query, or fragment."
                .to_owned(),
        ));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    if let Some(configured_headers) = config.get("headers").and_then(Value::as_object) {
        for (key, value) in configured_headers {
            if let Some(value) = value.as_str().filter(|value| !value.trim().is_empty()) {
                let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                    .map_err(|error| error.to_string())?;
                let value = reqwest::header::HeaderValue::from_str(value)
                    .map_err(|error| error.to_string())?;
                headers.insert(name, value);
            }
        }
    }
    let has_auth_header = headers
        .get(reqwest::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.trim().to_ascii_lowercase().starts_with("bearer ") && value.trim().len() > 7
        });
    if !has_auth_header
        && let Some(token) = nonempty(config, "apiKey")
            .or_else(|| nonempty(config, "authToken"))
            .or_else(|| nonempty(config, "token"))
    {
        let token = if token.to_ascii_lowercase().starts_with("bearer ") {
            token
        } else {
            format!("Bearer {token}")
        };
        headers.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&token).map_err(|error| error.to_string())?,
        );
    }
    if headers
        .get(reqwest::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| {
            !value.trim().to_ascii_lowercase().starts_with("bearer ") || value.trim().len() <= 7
        })
    {
        return Ok(Some(
            "Hermes API Server requires an explicit Bearer API key.".to_owned(),
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .default_headers(headers)
        .build()
        .map_err(|error| error.to_string())?;
    let mut errors = Vec::new();
    let mut warnings = false;
    let health = hermes_get(&client, &base, "/health").await;
    match health {
        Ok((status, body)) if status.is_success() => {
            let version = body
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !["0.18.2", "0.19.1"].contains(&version) {
                errors.push(format!(
                    "Hermes version {} is not in the supported compatibility matrix.",
                    if version.is_empty() {
                        "unknown"
                    } else {
                        version
                    }
                ));
            }
        }
        Ok((status, _)) => errors.push(format!("Hermes health returned HTTP {}.", status.as_u16())),
        Err(error) => errors.push(error),
    }
    match hermes_get(&client, &base, "/health/detailed").await {
        Ok((status, body)) if status.is_success() => {
            let runtime = body
                .get("readiness")
                .filter(|value| value.is_object())
                .or_else(|| body.get("runtime"));
            if runtime
                .and_then(|value| value.get("mode"))
                .and_then(Value::as_str)
                .is_some_and(|mode| mode != "server_agent")
            {
                errors.push(format!(
                    "Hermes runtime mode {} is not server_agent.",
                    runtime.unwrap()["mode"].as_str().unwrap_or_default()
                ));
            }
        }
        Ok((status, _)) => errors.push(format!(
            "Hermes detailed health returned HTTP {}.",
            status.as_u16()
        )),
        Err(error) => errors.push(error),
    }
    let required_features = [
        "run_submission",
        "run_status",
        "run_events_sse",
        "run_stop",
        "run_approval_response",
        "session_resources",
    ];
    let required_endpoints = [
        ("runs", "/v1/runs"),
        ("run_status", "/v1/runs/{run_id}"),
        ("run_events", "/v1/runs/{run_id}/events"),
        ("run_approval", "/v1/runs/{run_id}/approval"),
        ("run_stop", "/v1/runs/{run_id}/stop"),
        ("sessions", "/api/sessions"),
        ("session_create", "/api/sessions"),
        ("session", "/api/sessions/{session_id}"),
        ("session_messages", "/api/sessions/{session_id}/messages"),
    ];
    match hermes_get(&client, &base, "/v1/capabilities").await {
        Ok((status, body)) if status.is_success() => {
            let mut missing = required_features
                .iter()
                .filter(|key| body["features"][**key] != true)
                .map(|key| (*key).to_owned())
                .collect::<Vec<_>>();
            if body["runtime"]["tool_execution"] != "server" {
                missing.push("tool_execution:server".into());
            }
            for (key, endpoint) in required_endpoints {
                if body["endpoints"][key]["path"] != endpoint {
                    missing.push(format!("endpoint:{key}"));
                }
            }
            if !missing.is_empty() {
                errors.push(format!(
                    "Hermes API Server is missing required capabilities: {}.",
                    missing.join(", ")
                ));
            }
        }
        Ok((status, _)) => errors.push(format!(
            "Hermes capabilities returned HTTP {}.",
            status.as_u16()
        )),
        Err(error) => errors.push(error),
    }
    match hermes_get(&client, &base, "/v1/models").await {
        Ok((status, _)) if !status.is_success() => warnings = true,
        Err(_) => warnings = true,
        _ => {}
    }
    if let Some(error) = errors.into_iter().next() {
        return Ok(Some(error));
    }
    if warnings {
        return Ok(Some(blocking_warn()));
    }
    Ok(None)
}

async fn hermes_get(
    client: &reqwest::Client,
    base: &url::Url,
    path: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let mut endpoint = base.clone();
    let prefix = endpoint.path().trim_end_matches('/');
    endpoint.set_path(&format!("{prefix}{path}"));
    endpoint.set_query(None);
    let response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|_| blocking_warn())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|_| blocking_warn())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Hermes response exceeded 4194304 bytes".into());
    }
    let body = serde_json::from_slice::<Value>(&bytes)
        .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)}));
    Ok((status, body))
}

async fn test_hermes_local(config: &Value) -> Result<Option<String>, String> {
    let command = nonempty(config, "hermesCommand").unwrap_or_else(|| "hermes".to_owned());
    let host_cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let host_config = Value::Null;
    let command_issue = command_error(&command, &host_cwd, &host_config);
    let command_missing = command_issue.as_deref().is_some_and(|issue| {
        issue.starts_with("Command not found in PATH:")
            || ((command.contains('/') || command.contains('\\'))
                && !absolute_path(if Path::new(&command).is_absolute() {
                    PathBuf::from(&command)
                } else {
                    host_cwd.join(&command)
                })
                .exists())
    });
    if command_missing {
        return Ok(Some(format!("Hermes CLI \"{command}\" not found in PATH")));
    }
    let _installed_check = run_command(
        &command,
        &["--version".into()],
        &host_cwd,
        &host_config,
        None,
        10,
    )
    .await;
    // Node treats any non-ENOENT failure from this first check as an installed
    // CLI, then lets the following version check decide whether to warn.
    // command_error above already establishes that the executable resolves.
    let version = match run_command(
        &command,
        &["--version".into()],
        &host_cwd,
        &host_config,
        None,
        10,
    )
    .await
    {
        Ok(version) => version,
        Err(_) => return Ok(Some(blocking_warn())),
    };
    if version.timed_out || version.status != Some(0) || version.stdout.trim().is_empty() {
        return Ok(Some(blocking_warn()));
    }
    let python = run_command(
        "python3",
        &["--version".into()],
        &host_cwd,
        &host_config,
        None,
        5,
    )
    .await;
    let python = match python {
        Ok(output) if output.status == Some(0) => output.stdout,
        _ => return Ok(Some(blocking_warn())),
    };
    let version_text = python.trim();
    if let Some((major, minor)) = parse_python_version(version_text)
        && (major < 3 || (major == 3 && minor < 10))
    {
        return Ok(Some(format!(
            "Python {version_text} found — Hermes requires Python 3.10+"
        )));
    }
    let key_names = [
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENAI_API_KEY",
        "ZAI_API_KEY",
        "KIMI_API_KEY",
        "MINIMAX_API_KEY",
    ];
    if !key_names
        .iter()
        .any(|key| env_nonempty(config, key).is_some())
    {
        return Ok(Some(blocking_warn()));
    }

    let model = config.get("model").and_then(Value::as_str);
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        let explicit_provider = config.get("provider").and_then(Value::as_str);
        let detected =
            detect_hermes_model_config(&home_directory(config, false).join(".hermes/config.yaml"));
        if hermes_provider_warning(explicit_provider, detected.as_ref(), model) {
            return Ok(Some(blocking_warn()));
        }
    }
    Ok(None)
}

#[derive(Debug, Eq, PartialEq)]
struct DetectedHermesModel {
    model: String,
    provider: String,
}

fn detect_hermes_model_config(path: &Path) -> Option<DetectedHermesModel> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| parse_hermes_model_config(&content))
}

fn parse_hermes_model_config(content: &str) -> Option<DetectedHermesModel> {
    let mut model = String::new();
    let mut provider = String::new();
    let mut in_model_section = false;
    for line in content.lines() {
        let trimmed_end = line.trim_end();
        let indent = line.len() - line.trim_start().len();
        if trimmed_end == "model:" && indent == 0 {
            in_model_section = true;
            continue;
        }
        if in_model_section
            && indent == 0
            && !trimmed_end.trim().is_empty()
            && !trimmed_end.trim().starts_with('#')
        {
            in_model_section = false;
        }
        if !in_model_section {
            continue;
        }
        let trimmed = trimmed_end.trim_start();
        let Some((key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        if !key
            .chars()
            .all(|character| character == '_' || character.is_ascii_alphanumeric())
        {
            continue;
        }
        let value = raw_value
            .trim()
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches(['\'', '"']);
        match key {
            "default" => model = value.to_owned(),
            "provider" => provider = value.to_owned(),
            _ => {}
        }
    }
    (!model.is_empty()).then_some(DetectedHermesModel { model, provider })
}

fn resolve_hermes_provider(
    explicit: Option<&str>,
    detected: Option<&DetectedHermesModel>,
    model: &str,
) -> &'static str {
    const VALID: &[&str] = &[
        "auto",
        "openrouter",
        "nous",
        "openai-codex",
        "copilot",
        "copilot-acp",
        "anthropic",
        "huggingface",
        "zai",
        "kimi-coding",
        "minimax",
        "minimax-cn",
        "kilocode",
    ];
    if explicit.is_some_and(|provider| VALID.contains(&provider)) {
        return "adapterConfig";
    }
    if let Some(detected) = detected
        && VALID.contains(&detected.provider.as_str())
        && detected.model.eq_ignore_ascii_case(model)
    {
        return "hermesConfig";
    }
    if infer_hermes_provider(model).is_some() {
        "modelInference"
    } else {
        "auto"
    }
}

fn hermes_provider_warning(
    explicit: Option<&str>,
    detected: Option<&DetectedHermesModel>,
    model: &str,
) -> bool {
    if let (Some(explicit), Some(detected_provider)) = (
        explicit.filter(|provider| !provider.is_empty()),
        detected.map(|value| value.provider.as_str()),
    ) && !detected_provider.is_empty()
        && explicit != detected_provider
    {
        return true;
    }
    explicit.is_none_or(str::is_empty)
        && resolve_hermes_provider(explicit, detected, model) == "auto"
}

fn infer_hermes_provider(model: &str) -> Option<&'static str> {
    let lower = model.to_ascii_lowercase();
    let bare = lower.rsplit('/').next().unwrap_or(&lower);
    [
        ("gpt-4", "openai-codex"),
        ("gpt-5", "copilot"),
        ("o1-", "openai-codex"),
        ("o3-", "openai-codex"),
        ("o4-", "openai-codex"),
        ("claude", "anthropic"),
        ("gemini", "auto"),
        ("hermes-", "nous"),
        ("glm-", "zai"),
        ("moonshot", "kimi-coding"),
        ("kimi", "kimi-coding"),
        ("minimax", "minimax"),
        ("deepseek", "auto"),
        ("llama", "auto"),
        ("qwen", "auto"),
        ("mistral", "auto"),
    ]
    .into_iter()
    .find_map(|(prefix, provider)| bare.starts_with(prefix).then_some(provider))
}

fn parse_python_version(value: &str) -> Option<(u32, u32)> {
    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() {
            continue;
        }
        let major_end = (start..bytes.len())
            .find(|index| !bytes[*index].is_ascii_digit())
            .unwrap_or(bytes.len());
        if bytes.get(major_end) != Some(&b'.') {
            continue;
        }
        let minor_start = major_end + 1;
        let minor_end = (minor_start..bytes.len())
            .find(|index| !bytes[*index].is_ascii_digit())
            .unwrap_or(bytes.len());
        if minor_start == minor_end {
            continue;
        }
        let major = value[start..major_end].parse().ok()?;
        let minor = value[minor_start..minor_end].parse().ok()?;
        return Some((major, minor));
    }
    None
}

fn loopback_host(host: &str) -> bool {
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "::1"
}

fn header_ci(headers: &[(String, String)], key: &str) -> Option<String> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_binary(path: &Path) {
        fs::create_dir_all(path.parent().expect("fixture binary parent")).unwrap();
        fs::write(path, b"fixture executable").unwrap();
    }

    fn mcp_binary_name() -> &'static str {
        if cfg!(windows) {
            "rudder-native.exe"
        } else {
            "rudder-native"
        }
    }

    #[test]
    fn native_mcp_resolution_uses_only_the_installed_sibling() {
        let root = tempfile::tempdir().unwrap();
        let foundation = root.path().join(if cfg!(windows) {
            "rudder-server-foundation.exe"
        } else {
            "rudder-server-foundation"
        });
        let native = root.path().join(mcp_binary_name());
        fixture_binary(&foundation);
        fixture_binary(&native);

        assert_eq!(
            resolve_native_mcp_server_binary(&foundation).unwrap(),
            native.canonicalize().unwrap()
        );
    }

    #[test]
    fn native_mcp_resolution_uses_rust_cli_from_cargo_test_layout() {
        let root = tempfile::tempdir().unwrap();
        let debug = root.path().join("debug");
        let deps = debug.join("deps");
        let test_executable = deps.join("agent_core-tests");
        let cli = debug.join(if cfg!(windows) {
            "rudder-cli.exe"
        } else {
            "rudder-cli"
        });
        fs::create_dir_all(&deps).unwrap();
        fixture_binary(&test_executable);
        fixture_binary(&cli);

        assert_eq!(
            resolve_native_mcp_server_binary(&test_executable).unwrap(),
            cli.canonicalize().unwrap()
        );
    }

    #[test]
    fn native_mcp_resolution_fails_closed_without_a_sibling_binary() {
        let root = tempfile::tempdir().unwrap();
        let foundation = root.path().join(if cfg!(windows) {
            "rudder-server-foundation.exe"
        } else {
            "rudder-server-foundation"
        });
        fixture_binary(&foundation);

        assert_eq!(
            resolve_native_mcp_server_binary(&foundation),
            Err("Rudder native MCP executable is unavailable beside the server".to_owned())
        );
    }

    #[test]
    fn claude_probe_uses_the_trusted_native_mcp_binary() {
        let binary = Path::new("/managed/native/rudder-native");
        let config = claude_probe_mcp_config(binary);
        assert_eq!(
            config["mcpServers"]["rudder-tools"]["command"],
            "/managed/native/rudder-native"
        );
        assert_eq!(
            config["mcpServers"]["rudder-tools"]["args"],
            json!(["mcp-server"])
        );
    }

    #[test]
    fn fallback_targets_match_runtime_and_config_merge_contract() {
        let targets = build_targets(
            "codex_local",
            &json!({
                "model": " primary ",
                "command": "codex",
                "modelFallbacks": [
                    {"model":"primary"},
                    {"agentRuntimeType":"http","model":" endpoint ","url":"https://top","config":{"url":"https://nested","method":"GET"}},
                    " shorthand ",
                    {"agentRuntimeType":"http","model":"endpoint"}
                ]
            }),
        );
        assert_eq!(targets.len(), 3);
        assert_eq!(targets[0].config["command"], "codex");
        assert!(targets[0].config.get("modelFallbacks").is_none());
        assert_eq!(targets[1].runtime_type, "http");
        assert_eq!(targets[1].config["model"], "endpoint");
        assert_eq!(targets[1].config["url"], "https://nested");
        assert_eq!(targets[1].config["method"], "GET");
        assert_eq!(targets[2].runtime_type, "codex_local");
        assert_eq!(targets[2].config["model"], "shorthand");
        assert!(targets[2].config.get("command").is_none());
    }

    #[test]
    fn codex_probe_defaults_and_boolean_alias_precedence_match_node() {
        let args = codex_probe_args(&json!({
            "dangerouslyBypassApprovalsAndSandbox": false,
            "dangerouslyBypassSandbox": true
        }));
        assert!(args.contains(&"--model".to_owned()));
        assert!(args.contains(&"gpt-5.6-luna".to_owned()));
        assert!(args.contains(&"model_reasoning_effort=\"medium\"".to_owned()));
        assert!(
            !args
                .iter()
                .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox")
        );

        let explicit_alias = codex_probe_args(&json!({"dangerouslyBypassSandbox": true}));
        assert!(
            explicit_alias
                .iter()
                .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox")
        );
    }

    #[test]
    fn claude_login_detection_matches_supported_login_prompts_without_broad_false_positives() {
        assert!(claude_auth_required(
            "Please run `claude auth login` or /login"
        ));
        assert!(claude_auth_required("Please run /login to continue"));
        assert!(!claude_auth_required(
            "Please run the project checks before release"
        ));
    }

    #[test]
    fn cursor_effort_replaces_case_insensitive_parameter_and_drops_unclosed_suffix() {
        assert_eq!(
            apply_cursor_effort("composer-1[temperature=0.2, Effort = high]", Some("low")),
            "composer-1[temperature=0.2,effort=low]"
        );
        assert_eq!(
            apply_cursor_effort("composer-1[effort=high", None),
            "composer-1"
        );
    }

    #[test]
    fn codex_probe_config_disables_plugins_and_bundled_skills_and_strips_managed_tables() {
        let source = concat!(
            "notify = ['legacy']\r\n",
            "service_tier = 'auto'\r\n",
            "keep = true\r\n",
            "[features]\r\nplugins = true\r\nother = true\r\n",
            "[skills.bundled]\r\nenabled = true\r\n",
            "[mcp_servers.private]\r\ncommand = 'unsafe'\r\n",
            "[plugins.private]\nenabled = true\r\n",
            "[[skills.config]]\npath = '/tmp/skill'\nenabled = true\n",
            "[provider]\nservice_tier = 'fast'\n"
        );
        let mcp_binary = Path::new("/managed/native/rudder-native");
        let result = sanitize_codex_probe_config(source, mcp_binary);
        assert!(result.contains("[features]\r\nplugins = false\r\nother = true"));
        assert!(result.contains("[skills.bundled]\r\nenabled = false"));
        assert!(!result.contains("notify ="));
        assert!(!result.contains("service_tier = 'auto'"));
        assert!(result.contains("service_tier = 'fast'"));
        assert!(!result.contains("[mcp_servers.private]"));
        assert!(!result.contains("[plugins.private]"));
        assert!(!result.contains("[[skills.config]]"));
        assert!(result.contains("[mcp_servers.rudder-tools]"));
        assert!(result.contains("command = \"/managed/native/rudder-native\""));
        assert!(!result.contains("command = \"rudder\""));
    }
}
