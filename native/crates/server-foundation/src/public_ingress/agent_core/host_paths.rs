use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub(super) struct AgentHostFacts {
    pub(super) home_directory: String,
    pub(super) process_working_directory: String,
    pub(super) instructions_host: InstructionsHostContext,
}

#[derive(Clone, Debug)]
pub(super) struct InstructionsHostContext {
    pub(super) instance_root: String,
    pub(super) workspace_home: String,
    pub(super) previous_documents_root: String,
    pub(super) friendly_workspace_home: bool,
    pub(super) hostname: String,
}

#[derive(Clone, Debug)]
struct HostEnvironment {
    rudder_home: Option<String>,
    instance_id: Option<String>,
    organization_workspace_home: Option<String>,
    home_directory: String,
    process_working_directory: String,
    hostname: String,
}

impl HostEnvironment {
    fn from_process() -> Result<Self, ()> {
        let home_directory = env_nonempty("RUDDER_NATIVE_HOST_HOME_DIRECTORY")
            .or_else(|| std::env::var("HOME").ok())
            .or_else(|| std::env::var("USERPROFILE").ok())
            .ok_or(())?;
        let process_working_directory =
            env_nonempty("RUDDER_NATIVE_HOST_PROCESS_WORKING_DIRECTORY")
                .or_else(|| {
                    std::env::current_dir()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                })
                .ok_or(())?;
        let hostname = env_nonempty("RUDDER_NATIVE_HOST_HOSTNAME")
            .or_else(system_hostname)
            .ok_or(())?;

        Ok(Self {
            rudder_home: std::env::var("RUDDER_NATIVE_HOST_RUDDER_HOME").ok(),
            instance_id: std::env::var("RUDDER_NATIVE_HOST_INSTANCE_ID").ok(),
            organization_workspace_home: std::env::var(
                "RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME",
            )
            .ok(),
            home_directory,
            process_working_directory,
            hostname,
        })
    }
}

impl AgentHostFacts {
    pub(super) fn resolve(org_id: &str) -> Result<Self, ()> {
        let environment = HostEnvironment::from_process()?;
        Self::resolve_from(&environment, org_id)
    }

    fn resolve_from(environment: &HostEnvironment, org_id: &str) -> Result<Self, ()> {
        let home_directory = absolute(
            &environment.process_working_directory,
            &environment.home_directory,
        )?;
        let process_working_directory = absolute(
            &environment.process_working_directory,
            &environment.process_working_directory,
        )?;
        let home = PathBuf::from(&home_directory);
        let rudder_home_env = nonblank(environment.rudder_home.as_deref());
        let organization_home_env = nonblank(environment.organization_workspace_home.as_deref());
        let rudder_home = match rudder_home_env {
            Some(value) => resolve_configured_path(&home, &process_working_directory, value)?,
            None => normalize(home.join(".rudder")),
        };
        let instance_id = environment
            .instance_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("default");
        if !valid_path_segment(instance_id) {
            return Err(());
        }
        let instance_root = normalize(rudder_home.join("instances").join(instance_id));
        let workspace_home = match organization_home_env {
            Some(value) => resolve_configured_path(&home, &process_working_directory, value)?,
            None if rudder_home_env.is_some() => normalize(instance_root.join("organizations")),
            None => normalize(home.join("Documents").join("Rudder")),
        };
        let previous_documents_base = if organization_home_env.is_some() {
            workspace_home.clone()
        } else {
            normalize(home.join("Documents").join("Rudder"))
        };
        let org_storage_key = organization_storage_key(org_id)?;
        let previous_documents_root = normalize(
            previous_documents_base
                .join("instances")
                .join(instance_id)
                .join("organizations")
                .join(org_storage_key)
                .join("workspaces"),
        );
        if environment.hostname.trim().is_empty() {
            return Err(());
        }

        Ok(Self {
            home_directory,
            process_working_directory,
            instructions_host: InstructionsHostContext {
                instance_root: instance_root.to_string_lossy().into_owned(),
                workspace_home: workspace_home.to_string_lossy().into_owned(),
                previous_documents_root: previous_documents_root.to_string_lossy().into_owned(),
                friendly_workspace_home: organization_home_env.is_some()
                    || rudder_home_env.is_none(),
                hostname: environment.hostname.clone(),
            },
        })
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn nonblank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn absolute(cwd: &str, value: &str) -> Result<String, ()> {
    let path = Path::new(value);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };
    let result = normalize(absolute);
    result
        .is_absolute()
        .then(|| result.to_string_lossy().into_owned())
        .ok_or(())
}

fn resolve_configured_path(home: &Path, cwd: &str, value: &str) -> Result<PathBuf, ()> {
    let expanded = if value == "~" {
        home.to_path_buf()
    } else if let Some(tail) = value.strip_prefix("~/") {
        home.join(tail)
    } else {
        PathBuf::from(value)
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        Path::new(cwd).join(expanded)
    };
    let result = normalize(absolute);
    result.is_absolute().then_some(result).ok_or(())
}

fn normalize(path: PathBuf) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if result.file_name().is_some() {
                    result.pop();
                }
            }
            Component::Normal(value) => result.push(value),
        }
    }
    result
}

fn valid_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn organization_storage_key(org_id: &str) -> Result<String, ()> {
    let normalized = org_id.trim();
    if !valid_path_segment(normalized) {
        return Err(());
    }
    let bytes = normalized.as_bytes();
    let is_uuid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14].to_ascii_lowercase(), b'1'..=b'5')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b');
    if is_uuid {
        Ok(normalized
            .bytes()
            .filter(|byte| *byte != b'-')
            .take(12)
            .map(|byte| (byte as char).to_ascii_lowercase())
            .collect())
    } else {
        Ok(normalized.to_owned())
    }
}

#[cfg(unix)]
fn system_hostname() -> Option<String> {
    let mut buffer = [0 as libc::c_char; 256];
    // SAFETY: the buffer is writable and its length is bounded and explicit.
    let status = unsafe { libc::gethostname(buffer.as_mut_ptr(), buffer.len()) };
    if status != 0 {
        return None;
    }
    // SAFETY: gethostname writes a NUL-terminated hostname when it fits; the
    // final byte is reserved as a terminator if the platform fills the buffer.
    buffer[buffer.len() - 1] = 0;
    let hostname = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .ok()?
        .trim();
    (!hostname.is_empty()).then(|| hostname.to_owned())
}

#[cfg(not(unix))]
fn system_hostname() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(
        rudder_home: Option<&str>,
        instance_id: Option<&str>,
        organization_workspace_home: Option<&str>,
    ) -> HostEnvironment {
        HostEnvironment {
            rudder_home: rudder_home.map(str::to_owned),
            instance_id: instance_id.map(str::to_owned),
            organization_workspace_home: organization_workspace_home.map(str::to_owned),
            home_directory: "/Users/example".to_owned(),
            process_working_directory: "/app/current".to_owned(),
            hostname: "rudder-host".to_owned(),
        }
    }

    #[test]
    fn default_paths_match_documents_workspace_layout() {
        let facts = AgentHostFacts::resolve_from(&environment(None, None, None), "org-1").unwrap();
        assert_eq!(facts.home_directory, "/Users/example");
        assert_eq!(facts.process_working_directory, "/app/current");
        assert_eq!(
            facts.instructions_host.instance_root,
            "/Users/example/.rudder/instances/default"
        );
        assert_eq!(
            facts.instructions_host.workspace_home,
            "/Users/example/Documents/Rudder"
        );
        assert_eq!(
            facts.instructions_host.previous_documents_root,
            "/Users/example/Documents/Rudder/instances/default/organizations/org-1/workspaces"
        );
        assert!(facts.instructions_host.friendly_workspace_home);
    }

    #[test]
    fn explicit_rudder_home_and_instance_preserve_managed_layout() {
        let facts = AgentHostFacts::resolve_from(
            &environment(Some("../state"), Some("worktree_2"), None),
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .unwrap();
        assert_eq!(
            facts.instructions_host.instance_root,
            "/app/state/instances/worktree_2"
        );
        assert_eq!(
            facts.instructions_host.workspace_home,
            "/app/state/instances/worktree_2/organizations"
        );
        assert_eq!(
            facts.instructions_host.previous_documents_root,
            "/Users/example/Documents/Rudder/instances/worktree_2/organizations/123e4567e89b/workspaces"
        );
        assert!(!facts.instructions_host.friendly_workspace_home);
    }

    #[test]
    fn configured_workspace_home_expands_home_and_controls_legacy_root() {
        let facts = AgentHostFacts::resolve_from(
            &environment(Some("/state"), None, Some("~/custom/../workspaces")),
            "org-1",
        )
        .unwrap();
        assert_eq!(
            facts.instructions_host.workspace_home,
            "/Users/example/workspaces"
        );
        assert_eq!(
            facts.instructions_host.previous_documents_root,
            "/Users/example/workspaces/instances/default/organizations/org-1/workspaces"
        );
        assert!(facts.instructions_host.friendly_workspace_home);
    }

    #[test]
    fn invalid_instance_and_org_storage_paths_fail_closed() {
        assert!(
            AgentHostFacts::resolve_from(&environment(None, Some("../escape"), None), "org-1")
                .is_err()
        );
        assert!(AgentHostFacts::resolve_from(&environment(None, None, None), "org/1").is_err());
    }
}
