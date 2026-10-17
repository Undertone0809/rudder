use super::{Result, invalid};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Local installation facts constructed by the Rust host. This type cannot be
/// deserialized from a request, and intentionally has no `Debug` implementation.
#[derive(Clone)]
pub struct LocalHostContext {
    host_id: String,
    instance_root: PathBuf,
    workspace_home: PathBuf,
    previous_documents_root: PathBuf,
    friendly_workspace_home: bool,
    managed_profiles_root: PathBuf,
    operator_home: PathBuf,
    codex_executable: PathBuf,
    executable_search_path: String,
    executable_search_path_trusted: bool,
    native_codex_profile: bool,
    operator_codex_home: Option<PathBuf>,
    hermes_executable: Option<PathBuf>,
    hermes_profiles_root: Option<PathBuf>,
    pi_node_executable: Option<PathBuf>,
    pi_cli_entry: Option<PathBuf>,
    pi_profiles_root: Option<PathBuf>,
}

impl LocalHostContext {
    #[allow(clippy::too_many_arguments)]
    pub fn from_rust_host(
        host_id: String,
        instance_root: PathBuf,
        workspace_home: PathBuf,
        previous_documents_root: PathBuf,
        friendly_workspace_home: bool,
        managed_profiles_root: PathBuf,
        operator_home: PathBuf,
        codex_executable: PathBuf,
    ) -> std::result::Result<Self, super::Error> {
        if host_id.is_empty()
            || host_id.len() > 128
            || !host_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err(invalid("invalid local host identity"));
        }
        Ok(Self {
            host_id,
            instance_root: canonical_directory(instance_root, "instance root")?,
            workspace_home: canonical_directory(workspace_home, "workspace home")?,
            previous_documents_root: absolute_path(
                previous_documents_root,
                "previous documents root",
            )?,
            friendly_workspace_home,
            managed_profiles_root: canonical_directory(
                managed_profiles_root,
                "managed profile root",
            )?,
            operator_home: canonical_directory(operator_home, "operator home")?,
            codex_executable: canonical_file(codex_executable, "Codex executable")?,
            executable_search_path: "/usr/bin:/bin".into(),
            executable_search_path_trusted: false,
            native_codex_profile: false,
            operator_codex_home: None,
            hermes_executable: None,
            hermes_profiles_root: None,
            pi_node_executable: None,
            pi_cli_entry: None,
            pi_profiles_root: None,
        })
    }

    /// Opt into the already-provisioned per-Agent Codex home under this
    /// trusted Rudder instance. The resolver never creates, copies, or edits
    /// that profile. The default remains the isolated synthetic fixture mode.
    pub fn with_native_codex_profile(mut self) -> Self {
        self.native_codex_profile = true;
        self
    }

    /// Select an existing operator-owned native profile without copying or
    /// provisioning credentials. Only the installation host supplies its path.
    pub fn with_operator_codex_profile(mut self, home: PathBuf) -> Result<Self> {
        self.operator_codex_home = Some(canonical_directory(home, "operator Codex profile")?);
        Ok(self)
    }

    pub(super) fn operator_codex_home(&self) -> Option<&Path> {
        self.operator_codex_home.as_deref()
    }

    /// Bind the trusted executable search path supplied by the Rust host.
    /// Only this value is passed to the Codex child; other operator variables
    /// are not inherited.
    pub fn with_executable_search_path(
        mut self,
        search_path: String,
    ) -> std::result::Result<Self, super::Error> {
        if search_path.is_empty() || search_path.len() > 16_384 || search_path.contains('\0') {
            return Err(invalid("trusted executable search path is invalid"));
        }
        let entries = std::env::split_paths(OsStr::new(&search_path)).collect::<Vec<_>>();
        if entries.is_empty()
            || entries
                .iter()
                .any(|entry| entry.as_os_str().is_empty() || !entry.is_absolute())
        {
            return Err(invalid("trusted executable search path is invalid"));
        }
        self.executable_search_path = search_path;
        self.executable_search_path_trusted = true;
        Ok(self)
    }

    /// Attach installed Hermes paths supplied by the Rust host. They are
    /// installation facts and must never come from a request or Agent config.
    pub fn with_hermes_runtime(
        mut self,
        executable: PathBuf,
        profiles_root: PathBuf,
    ) -> std::result::Result<Self, super::Error> {
        self.hermes_executable = Some(canonical_file(executable, "Hermes executable")?);
        self.hermes_profiles_root =
            Some(canonical_directory(profiles_root, "Hermes profile root")?);
        Ok(self)
    }

    /// Attach the installed Pi Node launcher, CLI entrypoint, and the
    /// Rust-owned profile root discovered by the local host. These paths are
    /// installation facts and cannot be supplied by HTTP or Agent config.
    pub fn with_pi_runtime(
        mut self,
        node_executable: PathBuf,
        pi_cli_entry: PathBuf,
        profiles_root: PathBuf,
    ) -> std::result::Result<Self, super::Error> {
        self.pi_node_executable = Some(canonical_file(node_executable, "Pi Node executable")?);
        self.pi_cli_entry = Some(canonical_file(pi_cli_entry, "Pi CLI entrypoint")?);
        self.pi_profiles_root = Some(canonical_directory(profiles_root, "Pi profile root")?);
        Ok(self)
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn codex_executable(&self) -> &Path {
        &self.codex_executable
    }

    pub fn hermes_executable(&self) -> Option<&Path> {
        self.hermes_executable.as_deref()
    }

    pub fn hermes_profiles_root(&self) -> Option<&Path> {
        self.hermes_profiles_root.as_deref()
    }

    pub(super) fn pi_runtime(&self) -> Option<(&Path, &Path, &Path)> {
        Some((
            self.pi_node_executable.as_deref()?,
            self.pi_cli_entry.as_deref()?,
            self.pi_profiles_root.as_deref()?,
        ))
    }

    pub(super) fn instance_root(&self) -> &Path {
        &self.instance_root
    }

    pub(super) fn workspace_home(&self) -> &Path {
        &self.workspace_home
    }

    pub(super) fn previous_documents_root(&self) -> &Path {
        &self.previous_documents_root
    }

    pub(super) fn friendly_workspace_home(&self) -> bool {
        self.friendly_workspace_home
    }

    pub(super) fn managed_profiles_root(&self) -> &Path {
        &self.managed_profiles_root
    }

    pub(super) fn operator_home(&self) -> &Path {
        &self.operator_home
    }

    pub(super) fn uses_native_codex_profile(&self) -> bool {
        self.native_codex_profile
    }

    /// Captured process search path from the trusted Rust host. Provider
    /// executors may consume this resolved value but cannot override it from
    /// Agent config or an HTTP request.
    pub fn executable_search_path(&self) -> &str {
        &self.executable_search_path
    }

    /// Whether the search path came from an explicit trusted host builder
    /// rather than a compatibility/test default.
    pub fn has_trusted_executable_search_path(&self) -> bool {
        self.executable_search_path_trusted
    }
}

fn canonical_directory(path: PathBuf, label: &'static str) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(invalid("local host path must be absolute"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| invalid("local host directory is unavailable"))?;
    if !canonical.is_dir() {
        return Err(invalid(label));
    }
    Ok(canonical)
}

fn canonical_file(path: PathBuf, label: &'static str) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(invalid("Codex executable must be absolute"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| invalid("Codex executable is unavailable"))?;
    if !canonical.is_file() {
        return Err(invalid(label));
    }
    Ok(canonical)
}

fn absolute_path(path: PathBuf, _label: &'static str) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(invalid("local host path must be absolute"));
    }
    Ok(path)
}
