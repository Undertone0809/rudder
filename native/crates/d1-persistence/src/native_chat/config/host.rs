use super::{Result, invalid};
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
        })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn codex_executable(&self) -> &Path {
        &self.codex_executable
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
