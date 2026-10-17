//! Construct native execution from installation facts on the real launcher.
//! Agent selection, profile validation and admission remain Rust-owned.

use crate::browser_auth::{BrowserAuthConfig, BrowserMutationPolicy};
use crate::public_ingress_config::NativeChatPublicRuntime;
use crate::{ConfigError, PublicIngressConfig};
use rudder_d1_persistence::native_chat::config::LocalHostContext;
use rudder_native_chat_executor::HostPaths;
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    instance_id: String,
    instance_root: PathBuf,
    workspace_home: PathBuf,
    operator_home: PathBuf,
    codex_home: Option<PathBuf>,
    executable_search_path: String,
    friendly_workspace_home: bool,
    deployment_mode: String,
    deployment_exposure: String,
    auth_requirement: String,
    trusted_origins: Vec<String>,
}

fn invalid_at(stage: &'static str) -> ConfigError {
    ConfigError::invalid("RUDDER_NATIVE_CHAT_HOST", stage)
}

pub(crate) fn configure(
    mut config: PublicIngressConfig,
) -> Result<PublicIngressConfig, ConfigError> {
    let Some(raw) = crate::optional_env("RUDDER_NATIVE_CHAT_HOST")? else {
        return Ok(config);
    };
    if raw.len() > 64 * 1024 {
        return Err(invalid_at("invalid native runtime installation"));
    }
    let installation: Installation =
        serde_json::from_str(&raw).map_err(|_| invalid_at("invalid installation shape"))?;
    if config.browser_auth.is_none() {
        config.browser_auth = Some(
            BrowserAuthConfig::local_implicit(
                config.listen_addr,
                &installation.deployment_mode,
                &installation.deployment_exposure,
                &installation.auth_requirement,
            )
            .map_err(|_| invalid_at("invalid local authentication deployment"))?,
        );
    }
    if config
        .browser_auth
        .as_ref()
        .is_some_and(BrowserAuthConfig::is_local_implicit)
        && installation
            .trusted_origins
            .iter()
            .any(|origin| !loopback_origin(origin))
    {
        return Err(invalid_at(
            "implicit local authentication requires loopback origins",
        ));
    }
    config.native_chat_mutations = Some(
        BrowserMutationPolicy::new(&installation.trusted_origins)
            .map_err(|_| invalid_at("invalid browser mutation origins"))?,
    );

    // Reading already accepted Native work does not require an installed CLI.
    // New admission is advertised only when the owned execution host exists.
    let Some(codex) = executable("codex", &installation.executable_search_path) else {
        return Ok(config);
    };
    let current =
        std::env::current_exe().map_err(|_| invalid_at("invalid native runtime installation"))?;
    let host_name = if cfg!(windows) {
        "rudder-process-host.exe"
    } else {
        "rudder-process-host"
    };
    let Some(process_host) = current
        .parent()
        .and_then(|parent| canonical_executable(&parent.join(host_name)))
    else {
        return Ok(config);
    };
    let instance = canonical_directory(&installation.instance_root)?;
    let workspace = canonical_directory(&installation.workspace_home)?;
    let operator_home = canonical_directory(&installation.operator_home)?;
    let native_root = instance.join("native-chat");
    let profiles = owned_directory(&native_root.join("profiles"))?;
    let runtime_root = owned_directory(&native_root.join("runtime"))?;
    let isolated_home = owned_directory(&native_root.join("isolated-home"))?;
    let previous_documents = operator_home.join("Documents/Rudder");
    let mut host = LocalHostContext::from_rust_host(
        format!("local:{}", installation.instance_id),
        instance,
        workspace,
        previous_documents,
        installation.friendly_workspace_home,
        profiles,
        operator_home.clone(),
        codex,
    )
    .map_err(|_| invalid_at("invalid native host paths or identity"))?
    .with_native_codex_profile()
    .with_executable_search_path(installation.executable_search_path.clone())
    .map_err(|_| invalid_at("invalid executable search path"))?;
    let operator_codex_home = installation
        .codex_home
        .unwrap_or_else(|| operator_home.join(".codex"));
    if operator_codex_home.is_dir() {
        host = host
            .with_operator_codex_profile(operator_codex_home)
            .map_err(|_| invalid_at("invalid operator Codex profile"))?;
    }
    let hermes_home = operator_home.join(".hermes");
    if hermes_home.is_dir()
        && let Some(hermes) = executable("hermes", &installation.executable_search_path)
    {
        host = host
            .with_hermes_runtime(hermes, hermes_home)
            .map_err(|_| invalid_at("invalid installed Hermes paths"))?;
    }
    config.native_chat_runtime = Some(
        NativeChatPublicRuntime::new(
            host,
            HostPaths {
                process_host,
                runtime_root,
                isolated_home,
            },
            Duration::from_secs(3600),
        )
        .map_err(|_| invalid_at("invalid native runtime lifetime"))?,
    );
    Ok(config)
}

fn executable(name: &str, search: &str) -> Option<PathBuf> {
    std::env::split_paths(search)
        .filter(|directory| directory.is_absolute())
        .find_map(|directory| canonical_executable(&directory.join(name)))
}

fn canonical_executable(path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    let metadata = canonical.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

fn canonical_directory(path: &Path) -> Result<PathBuf, ConfigError> {
    if !path.is_absolute() {
        return Err(invalid_at("invalid native runtime installation"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| invalid_at("invalid native runtime installation"))?;
    if !canonical.is_dir() {
        return Err(invalid_at("invalid native runtime installation"));
    }
    Ok(canonical)
}

fn owned_directory(path: &Path) -> Result<PathBuf, ConfigError> {
    // Refuse a symlink at the managed subtree before creating runtime files.
    for ancestor in path.ancestors().take(3) {
        if std::fs::symlink_metadata(ancestor)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(invalid_at("invalid native runtime installation"));
        }
    }
    std::fs::create_dir_all(path).map_err(|_| invalid_at("invalid native runtime installation"))?;
    canonical_directory(path)
}

fn loopback_origin(origin: &str) -> bool {
    url::Url::parse(origin)
        .ok()
        .is_some_and(|url| match url.host() {
            Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(address)) => address.is_loopback(),
            Some(url::Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn implicit_local_board_never_trusts_a_remote_origin() {
        for value in [
            "http://localhost:3100",
            "http://127.0.0.1:3100",
            "http://[::1]:3100",
        ] {
            assert!(super::loopback_origin(value));
        }
        for value in [
            "https://remote.example",
            "https://localhost.attacker.example",
            "null",
            "file:///tmp/page",
        ] {
            assert!(!super::loopback_origin(value));
        }
    }
}
