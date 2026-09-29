//! Synchronous parity with `ensureProjectLibraryLayout` in server/src/home-paths.ts.
//!
//! The caller ensures the organization layout and authorizes its root first. It
//! must recover the same command-bound Project ID and resolved name/key on a
//! precommit retry, or fail before invoking this helper. Receipt replay must not
//! invoke this helper. No identity here grants ownership of a shared directory.
//! SQL rollback does not undo filesystem writes; even a partial README is kept.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct ProjectLibraryCommand {
    pub command_id: String,
    pub request_fingerprint: String,
    pub project_id: String,
    pub org_id: String,
    /// Existing, absolute, caller-resolved and ownership-validated workspace root.
    pub organization_root: PathBuf,
    pub project_name: String,
    pub project_url_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectLibraryLayout {
    pub root: PathBuf,
    pub relative_path: PathBuf,
    pub readme_path: PathBuf,
}

#[derive(Debug)]
pub enum ProjectLibraryError {
    InvalidPath,
    /// The command's recorded intent differs or cannot be safely decoded.
    PathIdentityChanged,
    Io(io::Error),
}

impl fmt::Display for ProjectLibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => f.write_str("invalid Project Library path"),
            Self::PathIdentityChanged => f.write_str("Project Library path identity changed"),
            Self::Io(error) => write!(f, "Project Library filesystem error: {error}"),
        }
    }
}

impl std::error::Error for ProjectLibraryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ProjectLibraryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ProjectCreateIntent {
    org_id: String,
    command_id: String,
    request_fingerprint: String,
    project_id: String,
    project_name: String,
    project_url_key: String,
    organization_root: String,
}

/// Persist or validate precommit intent BEFORE any Project artifact writes.
///
/// `state_root` must be an existing, trusted, stable per-instance data directory,
/// provisioned durably by the caller, not a name-derived workspace directory.
/// Org/command digests select the record; the fingerprint and resolved values
/// belong in its contents so drift cannot silently select another record.
/// An identical retry reuses the record. Mismatched, partial, or malformed FINAL
/// records fail closed and are never overwritten or removed. Our writes target
/// staging files: a crash while writing leaves an ignored, retryable staging
/// entry, not a poisoned final record. This is not a recovery queue.
/// This record owns no Library directory or user file. Receipt replay bypasses
/// both this helper and `ensure_project_library`.
///
/// Unix syncs a staging file, hard-links it to the final name without replacement,
/// and syncs parent directory entries. Windows syncs
/// a writable regular-file handle (FlushFileBuffers), then publishes new files
/// and directories with MoveFileExW(MOVEFILE_WRITE_THROUGH), without replacement.
/// Windows does not try to flush directory handles. These are OS flush/publication
/// guarantees, not a guarantee against storage devices ignoring flush requests.
/// Staging entries are retained on failure/interruption, never treated as records.
/// Unix also retains the published staging link; no cleanup is performed here.
/// Pass instanceRoot/data, not instanceRoot/data/project-create-intents.
pub fn ensure_project_create_intent(
    state_root: &Path,
    command: &ProjectLibraryCommand,
) -> Result<(), ProjectLibraryError> {
    if !state_root.is_absolute()
        || state_root
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(ProjectLibraryError::InvalidPath);
    }
    require_directory(state_root)?;
    let intent = ProjectCreateIntent {
        org_id: command.org_id.clone(),
        command_id: command.command_id.clone(),
        request_fingerprint: command.request_fingerprint.clone(),
        project_id: command.project_id.clone(),
        project_name: command.project_name.clone(),
        project_url_key: command.project_url_key.clone(),
        organization_root: command
            .organization_root
            .to_str()
            .ok_or(ProjectLibraryError::InvalidPath)?
            .to_owned(),
    };
    let bytes = serde_json::to_vec(&intent)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let intents_root = state_root.join("project-create-intents");
    let org_root = intents_root.join(format!("{:x}", Sha256::digest(command.org_id.as_bytes())));
    let record_path = org_root.join(format!(
        "{:x}.json",
        Sha256::digest(command.command_id.as_bytes())
    ));
    match fs::symlink_metadata(&record_path) {
        // Compare an existing record below before inspecting possibly changed
        // workspace paths: even a now-missing replacement root is a conflict.
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if !command.organization_root.is_absolute()
                || command
                    .organization_root
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
            {
                return Err(ProjectLibraryError::InvalidPath);
            }
            require_directory(&command.organization_root)?;
            // Follow trusted aliases (including macOS /tmp), but never place
            // command state inside the shared workspace, even through an alias.
            if fs::canonicalize(state_root)?
                .starts_with(fs::canonicalize(&command.organization_root)?)
            {
                return Err(ProjectLibraryError::InvalidPath);
            }
            library_key(command)?;
        }
        Err(error) => return Err(error.into()),
    }
    ensure_intent_directory(&intents_root)?;
    ensure_intent_directory(&org_root)?;
    match publish_intent_record(&record_path, &bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            // A command record is a regular file, never an alias to user data.
            if !fs::symlink_metadata(&record_path)?.file_type().is_file() {
                return Err(ProjectLibraryError::PathIdentityChanged);
            }
            // FlushFileBuffers requires GENERIC_WRITE on Windows. Never create
            // or truncate on replay; bytes must remain exactly as recorded.
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&record_path)?;
            let recorded: ProjectCreateIntent = serde_json::from_reader(&file)
                .map_err(|_| ProjectLibraryError::PathIdentityChanged)?;
            if recorded != intent {
                return Err(ProjectLibraryError::PathIdentityChanged);
            }
            // An earlier writer may have stopped after writing complete JSON
            // but before syncing; an accepted retry also establishes durability.
            file.sync_all()?;
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    fs::File::open(&org_root)?.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn ensure_intent_directory(path: &Path) -> Result<(), ProjectLibraryError> {
    ensure_directory(path)?;
    fs::File::open(path.parent().ok_or(ProjectLibraryError::InvalidPath)?)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn ensure_intent_directory(path: &Path) -> Result<(), ProjectLibraryError> {
    match fs::symlink_metadata(path) {
        Ok(_) => return require_directory(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let stage = loop {
        let stage = intent_stage_path(path)?;
        match fs::create_dir(&stage) {
            Ok(()) => break stage,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    };
    match windows_publish_intent(&stage, path) {
        Ok(()) => Ok(()),
        // Another command may have published the same org directory. Keep our
        // staging directory, and only reuse a valid existing directory.
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => require_directory(path),
        Err(error) => Err(error.into()),
    }
}

fn publish_intent_record(path: &Path, bytes: &[u8]) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => return Err(io::ErrorKind::AlreadyExists.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let (stage, mut file) = loop {
        let stage = intent_stage_path(path)?;
        match OpenOptions::new().write(true).create_new(true).open(&stage) {
            Ok(file) => break (stage, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        // link is atomic and fails if final already exists. Only fully written,
        // synced bytes become visible; the caller syncs the containing directory.
        fs::hard_link(&stage, path)
    }
    #[cfg(windows)]
    {
        windows_publish_intent(&stage, path)
    }
}

fn intent_stage_path(destination: &Path) -> io::Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    Ok(parent.join(format!(
        ".project-create-pending-{}-{timestamp}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )))
}

#[cfg(windows)]
fn windows_publish_intent(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
    // Canonicalize only the existing parent, retaining the destination filename
    // and obtaining Windows extended-length paths without resolving the record.
    fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut wide: Vec<u16> = fs::canonicalize(parent)?
            .join(name)
            .as_os_str()
            .encode_wide()
            .collect();
        if wide.contains(&0) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        wide.push(0);
        Ok(wide)
    }
    let source = wide_path(source)?;
    let destination = wide_path(destination)?;
    // No REPLACE_EXISTING and no COPY_ALLOWED: same-parent, exclusive rename.
    // Microsoft documents WRITE_THROUGH as not returning until moved on disk:
    // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw
    // SAFETY: both pointers reference live, NUL-terminated UTF-16 buffers;
    // MoveFileExW retains neither pointer.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Ensure a name-derived shared Library directory and exclusively create README.
///
/// Existing README entries (including symlinks/directories) are left untouched,
/// matching Node's `wx`/EEXIST behavior. Existing directory symlinks are followed,
/// matching Node's recursive mkdir after the caller's organization-root checks.
/// Paths retain their lexical identity, including symlinked ancestors such as
/// macOS /tmp; this helper does not add a canonical-path containment policy.
pub fn ensure_project_library(
    command: &ProjectLibraryCommand,
) -> Result<ProjectLibraryLayout, ProjectLibraryError> {
    let key = library_key(command)?;
    if !command.organization_root.is_absolute()
        || command
            .organization_root
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(ProjectLibraryError::InvalidPath);
    }
    require_directory(&command.organization_root)?;
    let relative_path = PathBuf::from("projects").join(key);
    let projects_root = command.organization_root.join("projects");
    let root = command.organization_root.join(&relative_path);
    ensure_directory(&projects_root)?;
    ensure_directory(&root)?;
    let readme_path = root.join("README.md");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&readme_path)
    {
        Ok(mut file) => file.write_all(readme(&command.project_name).as_bytes())?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    Ok(ProjectLibraryLayout {
        root,
        relative_path,
        readme_path,
    })
}

fn require_directory(path: &Path) -> Result<(), ProjectLibraryError> {
    let metadata = fs::metadata(path)?;
    if metadata.is_dir() {
        Ok(())
    } else {
        Err(ProjectLibraryError::InvalidPath)
    }
}

fn ensure_directory(path: &Path) -> Result<(), ProjectLibraryError> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => require_directory(path),
        Err(error) => Err(error.into()),
    }
}

fn library_key(command: &ProjectLibraryCommand) -> Result<String, ProjectLibraryError> {
    let explicit = friendly_key(&command.project_url_key);
    let name = friendly_key(&command.project_name);
    let key = if !explicit.is_empty() {
        explicit
    } else if !name.is_empty() {
        name
    } else {
        let id = js_trim(&command.project_id);
        if id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return Err(ProjectLibraryError::InvalidPath);
        }
        id.to_owned()
    };
    // The legacy sanitizer preserves dots; do not let '.' or '..' collapse a
    // directory level. Every other emitted byte is a safe ASCII component byte.
    if key == "." || key == ".." {
        return Err(ProjectLibraryError::InvalidPath);
    }
    Ok(key)
}

fn friendly_key(value: &str) -> String {
    let mut result = String::new();
    let mut replacing = false;
    for c in js_trim(value).chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            result.push(c.to_ascii_lowercase());
            replacing = false;
        } else if !replacing {
            result.push('-');
            replacing = true;
        }
    }
    result.trim_matches('-').to_owned()
}

// ECMAScript trim differs from Rust str::trim for BOM and U+0085.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

fn readme(project_name: &str) -> String {
    let name = js_trim(project_name);
    let name = if name.is_empty() { "Project" } else { name };
    format!(
        "# {name}\n\nAgents should keep durable project work files inside this folder.\nAttached Project Resources are surfaced in the Library tree under `resources/` as virtual references; external resources are not copied into this folder.\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "rudder-project-library-{}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("create test fixture: {e}"),
                }
            }
        }

        fn command(&self) -> ProjectLibraryCommand {
            ProjectLibraryCommand {
                command_id: "command-a".into(),
                request_fingerprint: "fingerprint-a".into(),
                project_id: "Project_ID-123".into(),
                org_id: "org-a".into(),
                organization_root: self.0.clone(),
                project_name: "  Project Library Demo  ".into(),
                project_url_key: "project-library-demo".into(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove owned test fixture");
        }
    }

    fn intent_record(state: &Fixture, command: &ProjectLibraryCommand) -> PathBuf {
        state
            .0
            .join("project-create-intents")
            .join(format!("{:x}", Sha256::digest(command.org_id.as_bytes())))
            .join(format!(
                "{:x}.json",
                Sha256::digest(command.command_id.as_bytes())
            ))
    }

    #[test]
    fn intent_retry_keeps_record_bytes_and_creates_no_project_artifacts() {
        let workspace = Fixture::new();
        let state = Fixture::new();
        let command = workspace.command();
        ensure_project_create_intent(&state.0, &command).unwrap();
        let path = intent_record(&state, &command);
        let original = fs::read(&path).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let record: serde_json::Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(record["org_id"], command.org_id);
        assert_eq!(record["command_id"], command.command_id);
        assert_eq!(record["request_fingerprint"], command.request_fingerprint);
        assert_eq!(record["project_id"], command.project_id);
        assert_eq!(record["project_name"], command.project_name);
        assert_eq!(record["project_url_key"], command.project_url_key);
        assert_eq!(
            record["organization_root"],
            command.organization_root.to_str().unwrap()
        );
        ensure_project_create_intent(&state.0, &command).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert_eq!(fs::read_dir(&workspace.0).unwrap().count(), 0);
    }

    #[test]
    fn intent_drift_fails_without_overwriting_record_or_creating_second_path() {
        let workspace = Fixture::new();
        let other_workspace = Fixture::new();
        let state = Fixture::new();
        let command = workspace.command();
        ensure_project_create_intent(&state.0, &command).unwrap();
        let path = intent_record(&state, &command);
        let original = fs::read(&path).unwrap();
        for field in [
            "name",
            "urlkey",
            "root",
            "missing_root",
            "fingerprint",
            "project_id",
        ] {
            let mut changed = command.clone();
            match field {
                "name" => changed.project_name = "Different Name".into(),
                "urlkey" => changed.project_url_key = "different-key".into(),
                "root" => changed.organization_root = other_workspace.0.clone(),
                "missing_root" => changed.organization_root = other_workspace.0.join("missing"),
                "fingerprint" => changed.request_fingerprint = "different-request".into(),
                _ => changed.project_id = "different-project".into(),
            }
            assert!(
                matches!(
                    ensure_project_create_intent(&state.0, &changed),
                    Err(ProjectLibraryError::PathIdentityChanged)
                ),
                "field: {field}"
            );
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        assert_eq!(fs::read_dir(&workspace.0).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&other_workspace.0).unwrap().count(), 0);
    }

    #[test]
    fn interrupted_staging_write_does_not_poison_same_command_retry() {
        let workspace = Fixture::new();
        let state = Fixture::new();
        let command = workspace.command();
        let path = intent_record(&state, &command);
        let org_root = path.parent().unwrap();
        ensure_intent_directory(org_root.parent().unwrap()).unwrap();
        ensure_intent_directory(org_root).unwrap();
        let stage = intent_stage_path(&path).unwrap();
        let partial = b"{\"org_id\":\"org-a\",\"command_id\":";
        let mut interrupted = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)
            .unwrap();
        interrupted.write_all(partial).unwrap();
        interrupted.sync_all().unwrap();
        drop(interrupted);
        assert!(!path.exists());
        ensure_project_create_intent(&state.0, &command).unwrap();
        let complete = fs::read(&path).unwrap();
        let recorded: ProjectCreateIntent = serde_json::from_slice(&complete).unwrap();
        assert_eq!(recorded.command_id, command.command_id);
        assert_eq!(recorded.project_id, command.project_id);
        assert_eq!(recorded.project_name, command.project_name);
        ensure_project_create_intent(&state.0, &command).unwrap();
        assert_eq!(fs::read(&path).unwrap(), complete);
        assert_eq!(fs::read(&stage).unwrap(), partial);
        assert!(!workspace.0.join("projects").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_final_publication_does_not_replace_a_competing_record() {
        let state = Fixture::new();
        let path = state.0.join("intent.json");
        let stage = intent_stage_path(&path).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)
            .unwrap();
        file.write_all(b"first complete record").unwrap();
        file.sync_all().unwrap();
        drop(file);
        fs::write(&path, b"competing record").unwrap();
        assert_eq!(
            fs::hard_link(&stage, &path).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&path).unwrap(), b"competing record");
        assert_eq!(fs::read(&stage).unwrap(), b"first complete record");
    }

    #[test]
    fn malformed_partial_and_foreign_intent_records_are_retained() {
        let workspace = Fixture::new();
        let state = Fixture::new();
        let command = workspace.command();
        ensure_project_create_intent(&state.0, &command).unwrap();
        let path = intent_record(&state, &command);
        let valid: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut foreign = valid.clone();
        foreign["org_id"] = serde_json::json!("other-org");
        let mut extra = valid;
        extra["unknown"] = serde_json::json!(true);
        for bytes in [
            Vec::new(),
            b"{\"org_id\":".to_vec(),
            b"{}".to_vec(),
            serde_json::to_vec(&foreign).unwrap(),
            serde_json::to_vec(&extra).unwrap(),
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(matches!(
                ensure_project_create_intent(&state.0, &command),
                Err(ProjectLibraryError::PathIdentityChanged)
            ));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        assert!(!workspace.0.join("projects").exists());
    }

    #[test]
    fn distinct_command_intents_allow_same_name_shared_library() {
        let workspace = Fixture::new();
        let state = Fixture::new();
        let first = workspace.command();
        let mut second = first.clone();
        second.command_id = "another-command".into();
        second.request_fingerprint = "another-fingerprint".into();
        second.project_id = "another-project".into();
        ensure_project_create_intent(&state.0, &first).unwrap();
        let layout = ensure_project_library(&first).unwrap();
        fs::write(&layout.readme_path, b"user README").unwrap();
        ensure_project_create_intent(&state.0, &second).unwrap();
        assert_eq!(ensure_project_library(&second).unwrap(), layout);
        assert!(intent_record(&state, &first).is_file());
        assert!(intent_record(&state, &second).is_file());
        assert_ne!(
            intent_record(&state, &first),
            intent_record(&state, &second)
        );
        assert_eq!(fs::read(layout.readme_path).unwrap(), b"user README");
        assert_eq!(fs::read_dir(layout.root).unwrap().count(), 1);
    }

    #[test]
    fn intent_state_cannot_be_inside_organization_workspace() {
        let workspace = Fixture::new();
        let nested = workspace.0.join("state");
        fs::create_dir(&nested).unwrap();
        for root in [&workspace.0, &nested] {
            assert!(matches!(
                ensure_project_create_intent(root, &workspace.command()),
                Err(ProjectLibraryError::InvalidPath)
            ));
            assert!(!root.join("project-create-intents").exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_write_through_publication_is_exclusive_for_files_and_directories() {
        let state = Fixture::new();
        let directory = state.0.join("intent-directory");
        ensure_intent_directory(&directory).unwrap();
        let record = directory.join("record.json");
        publish_intent_record(&record, b"original").unwrap();
        ensure_intent_directory(&directory).unwrap();
        assert_eq!(fs::read(&record).unwrap(), b"original");
        // Exercise the native race boundary directly, not just the pre-check in
        // publish_intent_record. A losing publisher retains its staging file.
        let competing = directory.join("competing.json");
        fs::write(&competing, b"different").unwrap();
        assert!(windows_publish_intent(&competing, &record).is_err());
        assert_eq!(fs::read(&record).unwrap(), b"original");
        assert_eq!(fs::read(&competing).unwrap(), b"different");
        let missing = directory.join("missing.json");
        assert!(windows_publish_intent(&missing, &directory.join("absent.json")).is_err());
        assert!(!directory.join("absent.json").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_retry_flush_requires_writable_record_and_never_truncates() {
        let workspace = Fixture::new();
        let state = Fixture::new();
        let command = workspace.command();
        ensure_project_create_intent(&state.0, &command).unwrap();
        let path = intent_record(&state, &command);
        let original = fs::read(&path).unwrap();
        ensure_project_create_intent(&state.0, &command).unwrap();
        let permissions = fs::metadata(&path).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&path, readonly).unwrap();
        let result = ensure_project_create_intent(&state.0, &command);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(matches!(result, Err(ProjectLibraryError::Io(_))));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!workspace.0.join("projects").exists());
    }

    #[test]
    fn legacy_key_vectors_and_fallbacks() {
        let fixture = Fixture::new();
        for (key, name, expected) in [
            ("Project-Library-Demo", "ignored", "project-library-demo"),
            (" v1.2_Name ", "ignored", "v1.2_name"),
            ("", " Hello / World! ", "hello-world"),
            ("---", "日本語", "Project_ID-123"),
            ("../escape", "ignored", "..-escape"),
            ("/absolute\\path", "ignored", "absolute-path"),
        ] {
            let mut command = fixture.command();
            command.project_url_key = key.into();
            command.project_name = name.into();
            assert_eq!(library_key(&command).unwrap(), expected);
        }
    }

    #[test]
    fn exact_layout_and_readme_bytes_without_resources_or_markers() {
        let fixture = Fixture::new();
        let layout = ensure_project_library(&fixture.command()).unwrap();
        assert_eq!(
            layout.relative_path,
            Path::new("projects/project-library-demo")
        );
        assert_eq!(layout.root, fixture.0.join(&layout.relative_path));
        assert_eq!(layout.readme_path, layout.root.join("README.md"));
        assert_eq!(
            fs::read_to_string(&layout.readme_path).unwrap(),
            "# Project Library Demo\n\nAgents should keep durable project work files inside this folder.\nAttached Project Resources are surfaced in the Library tree under `resources/` as virtual references; external resources are not copied into this folder.\n"
        );
        assert_eq!(fs::read_dir(&layout.root).unwrap().count(), 1);
    }

    #[test]
    fn javascript_title_whitespace_parity() {
        assert!(readme("\u{feff} \u{00a0}").starts_with("# Project\n"));
        assert!(readme("\u{feff} title \u{feff}").starts_with("# title\n"));
        assert!(readme("\u{85}title\u{85}").starts_with("# \u{85}title\u{85}\n"));
    }

    #[test]
    fn retries_and_new_uuid_share_directory_without_changing_user_files() {
        let fixture = Fixture::new();
        let mut command = fixture.command();
        let first = ensure_project_library(&command).unwrap();
        fs::write(&first.readme_path, b"user README\0bytes").unwrap();
        fs::write(first.root.join("notes.txt"), b"user notes").unwrap();
        assert_eq!(ensure_project_library(&command).unwrap(), first);
        command.project_id = "new-project".into();
        command.command_id = "new-command".into();
        command.request_fingerprint = "new-fingerprint".into();
        assert_eq!(ensure_project_library(&command).unwrap(), first);
        assert_eq!(fs::read(first.readme_path).unwrap(), b"user README\0bytes");
        assert_eq!(
            fs::read(first.root.join("notes.txt")).unwrap(),
            b"user notes"
        );
        assert_eq!(fs::read_dir(first.root).unwrap().count(), 2);
    }

    #[test]
    fn interrupted_directory_creation_is_reusable_and_partial_readme_is_preserved() {
        let fixture = Fixture::new();
        let command = fixture.command();
        let root = fixture.0.join("projects/project-library-demo");
        fs::create_dir_all(&root).unwrap();
        let layout = ensure_project_library(&command).unwrap();
        assert_eq!(
            fs::read_to_string(&layout.readme_path).unwrap(),
            readme(&command.project_name)
        );
        fs::write(&layout.readme_path, b"# partial").unwrap();
        ensure_project_library(&command).unwrap();
        assert_eq!(fs::read(layout.readme_path).unwrap(), b"# partial");
    }

    #[test]
    fn rejects_collapsing_keys_and_untrusted_root_before_creating_projects() {
        let fixture = Fixture::new();
        for key in [".", "..", " --..-- "] {
            let mut command = fixture.command();
            command.project_url_key = key.into();
            assert!(matches!(
                ensure_project_library(&command),
                Err(ProjectLibraryError::InvalidPath)
            ));
        }
        let mut command = fixture.command();
        command.organization_root = fixture.0.join("../other");
        assert!(matches!(
            ensure_project_library(&command),
            Err(ProjectLibraryError::InvalidPath)
        ));
        command.organization_root = PathBuf::from("relative-root");
        assert!(matches!(
            ensure_project_library(&command),
            Err(ProjectLibraryError::InvalidPath)
        ));
        assert!(!fixture.0.join("projects").exists());
    }

    #[test]
    fn directory_collision_propagates_without_overwrite() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("projects"), b"user file").unwrap();
        assert!(ensure_project_library(&fixture.command()).is_err());
        assert_eq!(fs::read(fixture.0.join("projects")).unwrap(), b"user file");
    }

    #[test]
    fn existing_readme_directory_is_eexist_parity() {
        let fixture = Fixture::new();
        let readme = fixture.0.join("projects/project-library-demo/README.md");
        fs::create_dir_all(&readme).unwrap();
        ensure_project_library(&fixture.command()).unwrap();
        assert!(readme.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn existing_directory_symlinks_follow_legacy_mkdir_semantics() {
        use std::os::unix::fs::symlink;
        for level in ["ancestor", "root", "projects", "project"] {
            let fixture = Fixture::new();
            let outside = Fixture::new();
            let mut command = fixture.command();
            let link = match level {
                "ancestor" => {
                    fs::create_dir(outside.0.join("organization")).unwrap();
                    command.organization_root = fixture.0.join("ancestor/organization");
                    fixture.0.join("ancestor")
                }
                "root" => {
                    command.organization_root = fixture.0.join("linked-root");
                    command.organization_root.clone()
                }
                "projects" => fixture.0.join("projects"),
                _ => {
                    fs::create_dir(fixture.0.join("projects")).unwrap();
                    fixture.0.join("projects/project-library-demo")
                }
            };
            symlink(&outside.0, &link).unwrap();
            let target_root = match level {
                "ancestor" => outside.0.join("organization/projects/project-library-demo"),
                "root" => outside.0.join("projects/project-library-demo"),
                "projects" => outside.0.join("project-library-demo"),
                _ => outside.0.clone(),
            };
            let layout = ensure_project_library(&command).unwrap();
            assert_eq!(
                layout.root,
                command
                    .organization_root
                    .join("projects/project-library-demo")
            );
            assert_eq!(
                fs::read_to_string(target_root.join("README.md")).unwrap(),
                readme(&command.project_name)
            );
            assert!(
                fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            fs::write(target_root.join("README.md"), b"user README").unwrap();
            fs::write(target_root.join("notes.txt"), b"user notes").unwrap();
            command.project_id = "recreated-project".into();
            command.command_id = "recreated-command".into();
            command.request_fingerprint = "recreated-fingerprint".into();
            assert_eq!(ensure_project_library(&command).unwrap(), layout);
            assert_eq!(
                fs::read(target_root.join("README.md")).unwrap(),
                b"user README"
            );
            assert_eq!(
                fs::read(target_root.join("notes.txt")).unwrap(),
                b"user notes"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlinks_to_files_or_missing_targets_fail_without_mutation() {
        use std::os::unix::fs::symlink;
        for dangling in [false, true] {
            let fixture = Fixture::new();
            let target = fixture.0.join("target");
            if !dangling {
                fs::write(&target, b"user file").unwrap();
            }
            symlink(&target, fixture.0.join("projects")).unwrap();
            assert!(ensure_project_library(&fixture.command()).is_err());
            if dangling {
                assert!(!target.exists());
            } else {
                assert_eq!(fs::read(target).unwrap(), b"user file");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_readme_symlinks_are_never_followed() {
        use std::os::unix::fs::symlink;
        for dangling in [false, true] {
            let fixture = Fixture::new();
            let outside = Fixture::new();
            let target = outside.0.join("user-readme");
            if !dangling {
                fs::write(&target, b"outside content").unwrap();
            }
            let root = fixture.0.join("projects/project-library-demo");
            fs::create_dir_all(&root).unwrap();
            symlink(&target, root.join("README.md")).unwrap();
            ensure_project_library(&fixture.command()).unwrap();
            if dangling {
                assert!(!target.exists());
            } else {
                assert_eq!(fs::read(target).unwrap(), b"outside content");
            }
        }
    }
}
