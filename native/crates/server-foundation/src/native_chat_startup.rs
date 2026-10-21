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
    /// Optional Pi paths are installation facts supplied by the trusted host.
    /// Both are required before Pi native admission is advertised.
    pi_node_executable: Option<PathBuf>,
    pi_cli_entry: Option<PathBuf>,
    /// Optional provider executables are installation facts from the Rust
    /// launcher. Their absence keeps the provider unavailable and never
    /// triggers a fallback to another runtime.
    claude_executable: Option<PathBuf>,
    cursor_executable: Option<PathBuf>,
    /// OpenCode is reached through an explicitly owned Server endpoint. The
    /// endpoint and bearer token are never accepted from a chat request.
    opencode_server_url: Option<String>,
    opencode_bearer_token: Option<String>,
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
    if installation.opencode_server_url.is_none() && installation.opencode_bearer_token.is_some() {
        return Err(invalid_at(
            "OpenCode bearer token requires an OpenCode Server URL",
        ));
    }
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
    // New admission is advertised only when a supported native provider has
    // an owned executable; an OpenCode URL alone cannot prove process cleanup.
    // Hermes must not be gated on Codex being present.
    let current =
        std::env::current_exe().map_err(|_| invalid_at("invalid native runtime installation"))?;
    let codex = executable("codex", &installation.executable_search_path);
    let hermes = executable("hermes", &installation.executable_search_path);
    let pi_node = installation
        .pi_node_executable
        .or_else(|| executable("node", &installation.executable_search_path));
    let pi_cli_entry = installation.pi_cli_entry;
    let claude = installation
        .claude_executable
        .or_else(|| executable("claude", &installation.executable_search_path));
    let cursor = installation
        .cursor_executable
        .or_else(|| executable("cursor-agent", &installation.executable_search_path));
    let opencode = executable("opencode", &installation.executable_search_path);
    let opencode_url = installation
        .opencode_server_url
        .as_deref()
        .map(url::Url::parse)
        .transpose()
        .map_err(|_| invalid_at("invalid OpenCode Server URL"))?
        .or_else(|| {
            opencode
                .as_ref()
                .and_then(|_| url::Url::parse("http://127.0.0.1:0/").ok())
        });
    let has_opencode = opencode.is_some();
    let has_pi = pi_node.is_some() && pi_cli_entry.is_some();
    let Some(host_executable) = preferred_native_executable(
        codex.clone(),
        hermes.clone(),
        has_pi.then(|| pi_node.clone()).flatten(),
        claude.clone(),
        cursor.clone(),
    )
    .or_else(|| opencode.clone())
    .or_else(|| has_opencode.then(|| current.clone()))
    .or_else(|| has_pi.then(|| current.clone())) else {
        return Ok(config);
    };
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
    let workspace = workspace_directory(&installation.workspace_home)?;
    let operator_home = canonical_directory(&installation.operator_home)?;
    let opencode_operator_profile_supported =
        standard_opencode_profile_environment(&operator_home, |name| std::env::var_os(name));
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
        // LocalHostContext retains a Codex executable carrier for source
        // compatibility. When only Hermes is installed, its path is an
        // unavailable-Codex sentinel; Hermes resolution never consults it.
        host_executable,
    )
    .map_err(|_| invalid_at("invalid native host paths or identity"))?
    .with_executable_search_path(installation.executable_search_path.clone())
    .map_err(|_| invalid_at("invalid executable search path"))?;
    host = host.with_opencode_operator_profile_supported(opencode_operator_profile_supported);
    if codex.is_some() {
        host = host.with_native_codex_profile();
        let operator_codex_home = installation
            .codex_home
            .unwrap_or_else(|| operator_home.join(".codex"));
        if operator_codex_home.is_dir() {
            host = host
                .with_operator_codex_profile(operator_codex_home)
                .map_err(|_| invalid_at("invalid operator Codex profile"))?;
        }
    }
    if has_pi {
        let (Some(node), Some(entry)) = (pi_node, pi_cli_entry) else {
            return Err(invalid_at("invalid installed Pi paths"));
        };
        let profiles = owned_directory(&native_root.join("pi-profiles"))?;
        owned_directory(&profiles.join("operator-sessions"))?;
        host = host
            .with_pi_runtime(node, entry, profiles)
            .map_err(|_| invalid_at("invalid installed Pi paths"))?;
    }
    let hermes_home = operator_home.join(".hermes");
    if hermes_home.is_dir()
        && let Some(hermes) = hermes
    {
        host = host
            .with_hermes_runtime(hermes, hermes_home)
            .map_err(|_| invalid_at("invalid installed Hermes paths"))?;
    }
    if let Some(claude) = claude {
        let profiles = owned_directory(&native_root.join("claude-profiles"))?;
        host = host
            .with_claude_runtime(claude, profiles)
            .map_err(|_| invalid_at("invalid installed Claude Code paths"))?;
    }
    if let Some(cursor) = cursor {
        let profiles = owned_directory(&native_root.join("cursor-profiles"))?;
        host = host
            .with_cursor_runtime(cursor, profiles)
            .map_err(|_| invalid_at("invalid installed Cursor paths"))?;
    }
    if let Some(server_url) = opencode_url {
        host = host
            .with_opencode_runtime(server_url, installation.opencode_bearer_token)
            .map_err(|_| invalid_at("invalid installed OpenCode Server paths"))?;
        if let Some(opencode) = opencode {
            host = host
                .with_opencode_executable(opencode)
                .map_err(|_| invalid_at("invalid installed OpenCode executable"))?;
        }
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

fn preferred_native_executable(
    codex: Option<PathBuf>,
    hermes: Option<PathBuf>,
    pi_node: Option<PathBuf>,
    claude: Option<PathBuf>,
    cursor: Option<PathBuf>,
) -> Option<PathBuf> {
    codex.or(hermes).or(pi_node).or(claude).or(cursor)
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

// An empty instance has no organizations for legacy reconciliation to visit.
// Initialize only its configured container before HTTP setup; missing parents
// are installation errors, not permission to create an arbitrary tree.
fn workspace_directory(path: &Path) -> Result<PathBuf, ConfigError> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !path.is_absolute()
                || path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                return Err(invalid_at("invalid native runtime installation"));
            }
            let parent = canonical_directory(
                path.parent()
                    .ok_or_else(|| invalid_at("invalid native runtime installation"))?,
            )?;
            owned_directory(
                &parent.join(
                    path.file_name()
                        .ok_or_else(|| invalid_at("invalid native runtime installation"))?,
                ),
            )
        }
        _ => canonical_directory(path),
    }
}

fn standard_opencode_profile_environment(
    home: &Path,
    read: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> bool {
    [
        ("XDG_CONFIG_HOME", home.join(".config")),
        ("XDG_DATA_HOME", home.join(".local/share")),
    ]
    .into_iter()
    .all(|(name, standard)| read(name).is_none_or(|value| value == standard))
        && [
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_CONFIG_CONTENT",
        ]
        .into_iter()
        .all(|name| read(name).is_none())
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
    use std::path::PathBuf;

    #[test]
    fn fresh_workspace_container_is_created_without_guessing_missing_parents() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().canonicalize().unwrap();
        let workspace = parent.join("organizations");
        assert_eq!(super::workspace_directory(&workspace).unwrap(), workspace);
        assert_eq!(std::fs::read_dir(&workspace).unwrap().count(), 0);
        assert_eq!(super::workspace_directory(&workspace).unwrap(), workspace);
        assert!(super::workspace_directory(&parent.join("missing/organizations")).is_err());
        assert!(!parent.join("missing").exists());
        assert!(super::workspace_directory(&parent.join("../escaped")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn fresh_workspace_container_does_not_follow_a_dangling_symlink() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().canonicalize().unwrap();
        let workspace = parent.join("organizations");
        let outside = parent.join("not-created");
        std::os::unix::fs::symlink(&outside, &workspace).unwrap();
        assert!(super::workspace_directory(&workspace).is_err());
        assert!(!outside.exists());
    }

    #[test]
    fn standard_opencode_profile_does_not_ignore_custom_host_config_roots() {
        let home = PathBuf::from("/operator");
        assert!(super::standard_opencode_profile_environment(&home, |_| {
            None
        }));
        assert!(super::standard_opencode_profile_environment(
            &home,
            |name| match name {
                "XDG_CONFIG_HOME" => Some(home.join(".config").into_os_string()),
                "XDG_DATA_HOME" => Some(home.join(".local/share").into_os_string()),
                _ => None,
            }
        ));
        for key in [
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_CONFIG_CONTENT",
        ] {
            assert!(!super::standard_opencode_profile_environment(
                &home,
                |name| (name == key).then(|| "/custom-root".into())
            ));
        }
    }

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

    #[test]
    fn hermes_can_activate_native_host_without_codex() {
        let hermes = PathBuf::from("/opt/rudder/bin/hermes");
        assert_eq!(
            super::preferred_native_executable(None, Some(hermes.clone()), None, None, None),
            Some(hermes)
        );
    }

    #[test]
    fn pi_node_can_anchor_native_host_when_other_runtimes_are_absent() {
        let node = PathBuf::from("/opt/rudder/node/bin/node");
        assert_eq!(
            super::preferred_native_executable(None, None, Some(node.clone()), None, None),
            Some(node)
        );
    }
}
