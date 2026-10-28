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
    // The transitional launcher also supplies its original workspace setting.
    // Validate that fact before using its resolved path: path.resolve would
    // otherwise erase a relative root or ParentDir before Rust can reject it.
    let workspace_input = crate::optional_env("RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME")?;
    validate_workspace_input(workspace_input.as_deref(), &installation.operator_home)?;
    validate_workspace_shape(&installation.workspace_home)?;
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

/// Assemble generic execution from the same installation facts as Native Chat.
/// Generic HTTP/process runtimes do not require an installed AI CLI.
pub(crate) fn agent_execution_host(
    config: &mut PublicIngressConfig,
    brokers: std::sync::Arc<crate::desktop_broker::DesktopBrokers>,
) -> Result<Option<std::sync::Arc<crate::agent_run_context::AgentRunContextHost>>, ConfigError> {
    let Some(raw_environment) = crate::optional_env("RUDDER_NATIVE_HOST_RUNTIME_ENVIRONMENT")? else {
        return Ok(None);
    };
    let Some(raw_installation) = crate::optional_env("RUDDER_NATIVE_CHAT_HOST")? else {
        return Err(invalid_at("generic execution requires installation facts"));
    };
    let installation: Installation = serde_json::from_str(&raw_installation)
        .map_err(|_| invalid_at("invalid installation shape"))?;
    let environment: std::collections::BTreeMap<String, String> = serde_json::from_str(&raw_environment)
        .map_err(|_| invalid_at("invalid operator environment facts"))?;
    let current = std::env::current_exe().map_err(|_| invalid_at("native executable unavailable"))?;
    let binary_directory = current.parent().ok_or_else(|| invalid_at("native executable unavailable"))?;
    let sibling = |name: &str| {
        let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() };
        canonical_executable(&binary_directory.join(file))
            .ok_or_else(|| invalid_at("required native execution binary unavailable"))
    };
    let process_host = sibling("rudder-process-host")?;
    let rudder_cli = sibling("rudder-cli")?;
    validate_workspace_input(
        crate::optional_env("RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME")?.as_deref(),
        &installation.operator_home,
    )?;
    let instance = canonical_directory(&installation.instance_root)?;
    let workspace = workspace_directory(&installation.workspace_home)?;
    let operator_home = canonical_directory(&installation.operator_home)?;
    let runtime_root = owned_directory(&instance.join("native-agent/runtime"))?;
    let api_url = crate::optional_env("RUDDER_NATIVE_HOST_API_URL")?
        .ok_or_else(|| invalid_at("public API URL unavailable"))?;
    let api = url::Url::parse(&api_url).map_err(|_| invalid_at("invalid public API URL"))?;
    let oauth_redirect_uri = if config.deployment_mode == "local_trusted" {
        let port = api.port_or_known_default().ok_or_else(|| invalid_at("invalid public API port"))?;
        format!("http://127.0.0.1:{port}/api/mcp/oauth/callback")
    } else {
        // Invalid/missing authenticated OAuth configuration disables OAuth use,
        // as before, rather than preventing non-OAuth runtimes from starting.
        crate::optional_env("RUDDER_NATIVE_HOST_AUTH_PUBLIC_BASE_URL")?
            .and_then(|base| url::Url::parse(&base).ok())
            .filter(|base| base.scheme() == "https" && base.username().is_empty()
                && base.password().is_none() && base.query().is_none() && base.fragment().is_none())
            .and_then(|base| base.join("/api/mcp/oauth/callback").ok())
            .map(|base| base.to_string()).unwrap_or_default()
    };
    if config.managed_mcp_host.is_none() {
        config.managed_mcp_host = Some(std::sync::Arc::new(crate::managed_mcp_runtime::Host {
            deployment_mode: config.deployment_mode.clone(), process_host: process_host.clone(),
            runtime_root: runtime_root.clone(), environment: environment.clone(), oauth_redirect_uri,
        }));
    }
    let bundled_skills_root = crate::optional_env("RUDDER_NATIVE_HOST_BUNDLED_SKILL_ROOTS")?
        .map(|raw| serde_json::from_str::<Vec<PathBuf>>(&raw))
        .transpose().map_err(|_| invalid_at("invalid bundled skill roots"))?
        .unwrap_or_default().into_iter().find_map(|root| {
            root.is_dir().then(|| root.canonicalize().ok()).flatten()
        });
    let process_cwd = PathBuf::from(crate::optional_env("RUDDER_NATIVE_HOST_PROCESS_WORKING_DIRECTORY")?
        .ok_or_else(|| invalid_at("operator working directory unavailable"))?);
    let hostname = crate::optional_env("RUDDER_NATIVE_HOST_HOSTNAME")?
        .ok_or_else(|| invalid_at("operator hostname unavailable"))?;
    Ok(Some(std::sync::Arc::new(crate::agent_run_context::AgentRunContextHost {
        deployment_mode: config.deployment_mode.clone(), desktop_brokers: brokers,
        workspace: rudder_d1_persistence::agent_core::OrganizationWorkspaceHost {
            instance_root: instance.to_string_lossy().into_owned(),
            workspace_home: workspace.to_string_lossy().into_owned(),
            previous_documents_root: operator_home.join("Documents/Rudder").to_string_lossy().into_owned(),
            friendly_workspace_home: installation.friendly_workspace_home, hostname,
        }, operator_home, process_cwd, executable_search_path: installation.executable_search_path,
        runtime_root, rudder_cli, process_host, api_url, bundled_skills_root, environment,
    })))
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

fn contains_parent_component(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        // Verbatim Windows paths do not parse forward slashes as separators.
        // Installation input still uses the launcher's two-separator syntax.
        path.as_os_str()
            .encode_wide()
            .collect::<Vec<_>>()
            .split(|character| matches!(*character, 47 | 92))
            .any(|component| component == [46, 46])
    }
    #[cfg(not(windows))]
    {
        path.components()
            .any(|component| component == std::path::Component::ParentDir)
    }
}

fn validate_workspace_shape(path: &Path) -> Result<(), ConfigError> {
    if !path.is_absolute() || contains_parent_component(path) {
        return Err(invalid_at(
            "workspace root must be absolute without parent traversal",
        ));
    }
    Ok(())
}

fn validate_workspace_input(input: Option<&str>, operator_home: &Path) -> Result<(), ConfigError> {
    let Some(input) = input.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    // Joining onto a verbatim Windows home would otherwise remove `..`.
    if contains_parent_component(Path::new(input)) {
        return Err(invalid_at(
            "workspace root must be absolute without parent traversal",
        ));
    }
    // Preserve the launcher's documented home-prefix expansion. Everything
    // else must already be absolute; never resolve relative input against cwd.
    let expanded = if input == "~" {
        operator_home.to_owned()
    } else if let Some(relative) = input.strip_prefix("~/") {
        operator_home.join(relative)
    } else {
        PathBuf::from(input)
    };
    validate_workspace_shape(&expanded)
}

fn workspace_directory(path: &Path) -> Result<PathBuf, ConfigError> {
    validate_workspace_shape(path)?;
    let invalid_workspace = || invalid_at("workspace root must resolve to a directory");
    match std::fs::symlink_metadata(path) {
        // Keep existing configured aliases compatible. A dangling alias or a
        // file still fails canonical_directory without creating anything.
        Ok(_) => canonical_directory(path).map_err(|_| invalid_workspace()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // This is a trusted launcher installation fact, never a request
            // path. Fresh instances have no organizations root until first use.
            std::fs::create_dir_all(path).map_err(|_| invalid_workspace())?;
            canonical_directory(path).map_err(|_| invalid_workspace())
        }
        Err(_) => Err(invalid_workspace()),
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
    use std::path::{Path, PathBuf};

    fn raw_child(root: &Path, tail: &str) -> PathBuf {
        // Path::join normalizes `..` on verbatim Windows roots. Preserve the
        // original installation input so this fixture exercises the guard.
        let mut raw = root.as_os_str().to_os_string();
        raw.push(std::path::MAIN_SEPARATOR_STR);
        raw.push(tail);
        PathBuf::from(raw)
    }

    #[test]
    fn original_launcher_workspace_input_cannot_hide_invalid_path_shape() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        assert!(super::validate_workspace_input(None, &root).is_ok());
        assert!(super::validate_workspace_input(Some("~/organizations"), &root).is_ok());
        assert!(super::validate_workspace_input(Some("~"), &root).is_ok());
        assert!(super::validate_workspace_input(Some(root.to_str().unwrap()), &root).is_ok());
        for input in ["relative/organizations", "~/existing/../organizations"] {
            let error = super::validate_workspace_input(Some(input), &root).unwrap_err();
            assert!(error.to_string().contains("workspace root"));
        }
        let traversal = format!("{}/existing/../organizations", root.display());
        std::fs::create_dir(root.join("existing")).unwrap();
        std::fs::create_dir(root.join("organizations")).unwrap();
        assert!(super::validate_workspace_input(Some(&traversal), &root).is_err());
    }

    #[test]
    fn first_run_workspace_root_is_created_and_reused() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let workspace = root.join("new-instance/organizations");
        assert!(!workspace.exists());
        assert_eq!(super::workspace_directory(&workspace).unwrap(), workspace);
        std::fs::write(workspace.join("existing.txt"), b"keep").unwrap();
        assert_eq!(super::workspace_directory(&workspace).unwrap(), workspace);
        assert_eq!(
            std::fs::read(workspace.join("existing.txt")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn invalid_workspace_roots_do_not_create_directories() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let relative = PathBuf::from(format!("rudder-relative-{}", uuid::Uuid::new_v4()));
        assert!(super::workspace_directory(&relative).is_err());
        assert!(!relative.exists());
        let file = root.join("file");
        std::fs::write(&file, b"keep").unwrap();
        assert!(super::workspace_directory(&file).is_err());
        assert!(super::workspace_directory(&file.join("organizations")).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"keep");
        assert!(super::workspace_directory(&raw_child(&root, "new/../organizations")).is_err());
        assert!(!root.join("new").exists());
        assert!(!root.join("organizations").exists());
        std::fs::create_dir(root.join("existing")).unwrap();
        std::fs::create_dir(root.join("organizations")).unwrap();
        assert!(
            super::workspace_directory(&raw_child(&root, "existing/../organizations")).is_err()
        );
        assert!(root.join("existing").is_dir());
        assert!(root.join("organizations").is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_workspace_input_rejects_both_separators_before_writes() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        for tail in [
            r"new\..\organizations",
            r"new/..\organizations",
            r"new\../organizations",
        ] {
            let candidate = raw_child(&root, tail);
            assert!(super::workspace_directory(&candidate).is_err());
            assert!(super::validate_workspace_input(candidate.to_str(), &root).is_err());
        }
        assert!(!root.join("new").exists());
        assert!(!root.join("organizations").exists());
    }

    #[cfg(unix)]
    #[test]
    fn configured_workspace_aliases_remain_compatible_but_dangling_aliases_fail() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        let alias = root.join("alias");
        symlink(&target, &alias).unwrap();
        assert_eq!(super::workspace_directory(&alias).unwrap(), target);
        assert_eq!(
            super::workspace_directory(&alias.join("organizations")).unwrap(),
            target.join("organizations")
        );
        assert!(
            std::fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let missing = root.join("missing");
        let dangling = root.join("dangling");
        symlink(&missing, &dangling).unwrap();
        assert!(super::workspace_directory(&dangling).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn fresh_workspace_container_creates_valid_nested_launcher_roots() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().canonicalize().unwrap();
        let workspace = parent.join("organizations");
        assert_eq!(super::workspace_directory(&workspace).unwrap(), workspace);
        assert_eq!(std::fs::read_dir(&workspace).unwrap().count(), 0);
        assert_eq!(super::workspace_directory(&workspace).unwrap(), workspace);
        let nested = parent.join("missing/organizations");
        assert_eq!(super::workspace_directory(&nested).unwrap(), nested);
        assert!(parent.join("missing").is_dir());
        assert!(super::workspace_directory(&raw_child(&parent, "../escaped")).is_err());
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
