//! Per-attempt instructions for private Automation Chat, preserving user files.
use crate::{Error, HostPaths};
use rudder_d1_persistence::native_chat::config::ResolvedCodexConfig;
use std::fs::OpenOptions;
use std::io::Write;

pub(crate) fn append(
    config: &mut ResolvedCodexConfig,
    context: &str,
    paths: &HostPaths,
    run: &str,
    attempt: &str,
) -> Result<(), Error> {
    let combined = match config.instruction_content.take() {
        Some(value) => format!("{value}\n\n{context}"),
        None => context.into(),
    };
    if config.identity.runtime_type == "pi_local" {
        let run = uuid::Uuid::parse_str(run).map_err(|_| Error::UnsupportedConfiguration)?;
        let attempt =
            uuid::Uuid::parse_str(attempt).map_err(|_| Error::UnsupportedConfiguration)?;
        let directory = paths
            .runtime_root
            .join(format!("automation-{run}-{attempt}"));
        std::fs::create_dir_all(&directory).map_err(|_| Error::UnsupportedConfiguration)?;
        if std::fs::symlink_metadata(&directory)
            .map_or(true, |m| !m.is_dir() || m.file_type().is_symlink())
        {
            return Err(Error::UnsupportedConfiguration);
        }
        let path = directory.join("system.md");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => file
                .write_all(combined.as_bytes())
                .map_err(|_| Error::UnsupportedConfiguration)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::symlink_metadata(&path)
                    .map_or(true, |m| !m.is_file() || m.file_type().is_symlink())
                {
                    return Err(Error::UnsupportedConfiguration);
                }
                if std::fs::read_to_string(&path).ok().as_deref() != Some(combined.as_str()) {
                    return Err(Error::UnsupportedConfiguration);
                }
            }
            Err(_) => return Err(Error::UnsupportedConfiguration),
        }
        // Retained under the existing attempt runtime root. An unresolved child
        // must never lose the system file through an in-memory Drop cleanup.
        config.instruction_source_path = Some(directory);
        config.instruction_entry_file = "system.md".into();
    }
    if let Some(local) = config.opencode.as_mut() {
        local.append_system_instructions(context);
    }
    config.instruction_content = Some(combined);
    Ok(())
}
