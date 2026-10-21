//! Safe projection of a claim-resolved managed Agent instruction entry into
//! Cursor's native project-rule format.
//!
//! Cursor reads `.cursor/rules/*.mdc` relative to the session cwd. Rudder only
//! writes one deterministic, namespaced file in the per-Agent managed cwd;
//! it never writes into the operator profile or an arbitrary project.

use sha2::{Digest, Sha256};
use std::path::Path;
use uuid::Uuid;

const RULE_PREFIX: &str = "rudder-agent-";
const MAX_RULE_BYTES: usize = 256 * 1024;

/// Instructions already resolved and fingerprinted by the locked D1 claim.
/// `content: None` means remove a previously materialized owned rule.
pub struct CursorManagedInstructionRule {
    pub agent_id: String,
    pub revision: String,
    pub content: Option<String>,
}

impl CursorManagedInstructionRule {
    pub(crate) fn validate(&self) -> Result<(), RuleError> {
        let id = Uuid::parse_str(&self.agent_id).map_err(|_| RuleError::Invalid)?;
        if id.to_string() != self.agent_id
            || !self.revision.starts_with("sha256:")
            || self.revision.len() != 71
            || !self.revision[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self
                .content
                .as_ref()
                .is_some_and(|value| value.len() > MAX_RULE_BYTES || value.contains('\0'))
        {
            return Err(RuleError::Invalid);
        }
        Ok(())
    }

    fn file_name(&self) -> String {
        format!("{RULE_PREFIX}{}.mdc", self.agent_id)
    }

    fn rendered(&self, content: &str) -> Vec<u8> {
        let source_digest = digest(self.revision.as_bytes());
        let body = if content.ends_with('\n') {
            content.to_owned()
        } else {
            format!("{content}\n")
        };
        let content_digest = digest(body.as_bytes());
        format!(
            "---\ndescription: Rudder managed Agent instructions\nalwaysApply: true\n---\n<!-- rudder-native-instructions-v1 agent={} revision={} content={} -->\n{}",
            self.agent_id, source_digest, content_digest, body
        )
        .into_bytes()
    }

    fn owns(&self, bytes: &[u8]) -> bool {
        let Ok(text) = std::str::from_utf8(bytes) else {
            return false;
        };
        if !text.starts_with(
            "---\ndescription: Rudder managed Agent instructions\nalwaysApply: true\n---\n",
        ) {
            return false;
        }
        let body = &text
            ["---\ndescription: Rudder managed Agent instructions\nalwaysApply: true\n---\n"
                .len()..];
        let Some((marker, content)) = body.split_once('\n') else {
            return false;
        };
        let prefix = format!(
            "<!-- rudder-native-instructions-v1 agent={} revision=",
            self.agent_id
        );
        let Some(remainder) = marker.strip_prefix(&prefix) else {
            return false;
        };
        let Some((source_revision, remainder)) = remainder.split_once(" content=") else {
            return false;
        };
        let Some(content_digest) = remainder.strip_suffix(" -->") else {
            return false;
        };
        valid_digest(source_revision)
            && valid_digest(content_digest)
            && content_digest == digest(content.as_bytes())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("Cursor managed instruction rule is invalid or collides with another file")]
pub enum RuleError {
    Invalid,
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn digest(bytes: &[u8]) -> String {
    let value = Sha256::digest(bytes);
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Materialize or safely remove the one rule owned by this Agent. The caller
/// only supplies this object for the canonical managed fallback cwd, and does
/// so after claim/source revalidation but before starting the Cursor process.
pub(crate) fn materialize(
    cwd: &Path,
    rule: &CursorManagedInstructionRule,
) -> Result<(), RuleError> {
    rule.validate()?;
    #[cfg(unix)]
    {
        unix::materialize(cwd, rule)
    }
    #[cfg(windows)]
    {
        windows::materialize(cwd, rule)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = cwd;
        Err(RuleError::Invalid)
    }
}

#[cfg(unix)]
mod unix {
    use super::{CursorManagedInstructionRule, RuleError};
    use std::{
        ffi::CString,
        fs::{self, File},
        io::{self, Read, Write},
        os::fd::{AsRawFd, FromRawFd},
        os::unix::ffi::OsStrExt,
        path::{Component, Path},
    };
    use uuid::Uuid;

    pub(super) fn materialize(
        cwd: &Path,
        rule: &CursorManagedInstructionRule,
    ) -> Result<(), RuleError> {
        let body = rule.content.as_deref().filter(|value| !value.is_empty());
        let Some(rules_dir) = open_rule_directory(cwd, body.is_some())? else {
            return Ok(());
        };
        let name = cstring(&rule.file_name())?;
        let lock_name = cstring(&format!(".rudder-cursor-lock-{}.lock", rule.agent_id))?;
        let Some(lock) = open_lock(rules_dir.as_raw_fd(), &lock_name)? else {
            return Ok(());
        };
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(RuleError::Invalid);
        }

        let existing = read_regular_at(rules_dir.as_raw_fd(), &name)?;
        if let Some(bytes) = existing.as_deref()
            && !rule.owns(bytes)
        {
            return Err(RuleError::Invalid);
        }

        match body {
            Some(body) => {
                let rendered = rule.rendered(body);
                let temporary = cstring(&format!(".{}.{}.tmp", rule.file_name(), Uuid::new_v4()))?;
                write_temporary(rules_dir.as_raw_fd(), &temporary, &rendered)?;
                let result = if existing.is_some() {
                    replace_owned(rules_dir.as_raw_fd(), &temporary, &name, rule)
                } else {
                    rename_noreplace(rules_dir.as_raw_fd(), &temporary, &name)
                };
                if result.is_err() {
                    let _ = unlink_at(rules_dir.as_raw_fd(), &temporary);
                }
                result?;
                rules_dir.sync_all().map_err(|_| RuleError::Invalid)?;
            }
            None => {
                if existing.is_some() {
                    remove_owned(rules_dir.as_raw_fd(), &name, rule)?;
                    rules_dir.sync_all().map_err(|_| RuleError::Invalid)?;
                }
            }
        }
        Ok(())
    }

    fn open_rule_directory(cwd: &Path, create: bool) -> Result<Option<File>, RuleError> {
        if !cwd.is_absolute()
            || cwd
                .components()
                .any(|part| matches!(part, Component::ParentDir))
            || fs::canonicalize(cwd).ok().as_deref() != Some(cwd)
        {
            return Err(RuleError::Invalid);
        }
        let mut current = open_root()?;
        let components = cwd.components().collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(value) = component else {
                if matches!(component, Component::RootDir | Component::CurDir) {
                    continue;
                }
                return Err(RuleError::Invalid);
            };
            current = match open_directory_at(
                current.as_raw_fd(),
                value,
                false,
                index + 1 == components.len(),
            )? {
                Some(next) => next,
                None => return Err(RuleError::Invalid),
            };
        }
        let Some(cursor_dir) = open_directory_at(
            current.as_raw_fd(),
            std::ffi::OsStr::new(".cursor"),
            create,
            true,
        )?
        else {
            return Ok(None);
        };
        open_directory_at(
            cursor_dir.as_raw_fd(),
            std::ffi::OsStr::new("rules"),
            create,
            true,
        )
    }

    fn open_root() -> Result<File, RuleError> {
        let root = CString::new("/").expect("constant path has no nul");
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(RuleError::Invalid);
        }
        // SAFETY: successful open returns a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        validate_directory(&file, false)?;
        Ok(file)
    }

    fn open_directory_at(
        parent: i32,
        name: &std::ffi::OsStr,
        create: bool,
        require_owned: bool,
    ) -> Result<Option<File>, RuleError> {
        let name = cstring_os(name)?;
        let mut fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 && create && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(RuleError::Invalid);
                }
            }
            fd = unsafe {
                libc::openat(
                    parent,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            let error = io::Error::last_os_error();
            if !create && error.kind() == io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(RuleError::Invalid);
        }
        // SAFETY: successful openat returns a new owned descriptor.
        let directory = unsafe { File::from_raw_fd(fd) };
        validate_directory(&directory, require_owned)?;
        Ok(Some(directory))
    }

    fn validate_directory(file: &File, require_owned: bool) -> Result<(), RuleError> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|_| RuleError::Invalid)?;
        if !metadata.is_dir() || (require_owned && metadata.uid() != unsafe { libc::geteuid() }) {
            return Err(RuleError::Invalid);
        }
        Ok(())
    }

    fn open_lock(parent: i32, name: &CString) -> Result<Option<File>, RuleError> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(RuleError::Invalid);
        }
        // SAFETY: successful openat returns a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        validate_regular(&file)?;
        Ok(Some(file))
    }

    fn read_regular_at(parent: i32, name: &CString) -> Result<Option<Vec<u8>>, RuleError> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(RuleError::Invalid);
        }
        // SAFETY: successful openat returns a new owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        validate_regular(&file)?;
        let length = file.metadata().map_err(|_| RuleError::Invalid)?.len();
        if length > super::MAX_RULE_BYTES as u64 {
            return Err(RuleError::Invalid);
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.read_to_end(&mut bytes)
            .map_err(|_| RuleError::Invalid)?;
        if bytes.len() as u64 != length {
            return Err(RuleError::Invalid);
        }
        Ok(Some(bytes))
    }

    fn validate_regular(file: &File) -> Result<(), RuleError> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|_| RuleError::Invalid)?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
        {
            return Err(RuleError::Invalid);
        }
        Ok(())
    }

    fn write_temporary(parent: i32, name: &CString, body: &[u8]) -> Result<(), RuleError> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(RuleError::Invalid);
        }
        // SAFETY: successful openat returns a new owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        validate_regular(&file)?;
        file.write_all(body).map_err(|_| RuleError::Invalid)?;
        file.sync_all().map_err(|_| RuleError::Invalid)
    }

    fn replace_owned(
        parent: i32,
        temporary: &CString,
        target: &CString,
        rule: &CursorManagedInstructionRule,
    ) -> Result<(), RuleError> {
        rename_exchange(parent, temporary, target)?;
        let old = read_regular_at(parent, temporary);
        match old {
            Ok(Some(bytes)) if rule.owns(&bytes) => unlink_at(parent, temporary),
            _ => {
                let _ = rename_exchange(parent, temporary, target);
                Err(RuleError::Invalid)
            }
        }
    }

    fn remove_owned(
        parent: i32,
        target: &CString,
        rule: &CursorManagedInstructionRule,
    ) -> Result<(), RuleError> {
        let temporary = cstring(&format!(".rudder-remove-{}.tmp", Uuid::new_v4()))?;
        rename_noreplace(parent, target, &temporary)?;
        match read_regular_at(parent, &temporary) {
            Ok(Some(bytes)) if rule.owns(&bytes) => unlink_at(parent, &temporary),
            _ => {
                let _ = rename_noreplace(parent, &temporary, target);
                Err(RuleError::Invalid)
            }
        }
    }

    fn rename_noreplace(parent: i32, from: &CString, to: &CString) -> Result<(), RuleError> {
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                parent,
                from.as_ptr(),
                parent,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                parent,
                from.as_ptr(),
                parent,
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let result = -1;
        if result == 0 {
            Ok(())
        } else {
            Err(RuleError::Invalid)
        }
    }

    fn rename_exchange(parent: i32, left: &CString, right: &CString) -> Result<(), RuleError> {
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                parent,
                left.as_ptr(),
                parent,
                right.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                parent,
                left.as_ptr(),
                parent,
                right.as_ptr(),
                libc::RENAME_SWAP,
            )
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let result = -1;
        if result == 0 {
            Ok(())
        } else {
            Err(RuleError::Invalid)
        }
    }

    fn unlink_at(parent: i32, name: &CString) -> Result<(), RuleError> {
        if unsafe { libc::unlinkat(parent, name.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(RuleError::Invalid)
        }
    }

    fn cstring(value: &str) -> Result<CString, RuleError> {
        CString::new(value).map_err(|_| RuleError::Invalid)
    }

    fn cstring_os(value: &std::ffi::OsStr) -> Result<CString, RuleError> {
        CString::new(value.as_bytes()).map_err(|_| RuleError::Invalid)
    }
}

#[cfg(windows)]
mod windows {
    use super::{CursorManagedInstructionRule, RuleError};
    use std::{
        fs::{self, OpenOptions},
        io::{Read, Write},
        os::windows::fs::{MetadataExt, OpenOptionsExt},
        path::{Component, Path},
    };
    use uuid::Uuid;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    pub(super) fn materialize(
        cwd: &Path,
        rule: &CursorManagedInstructionRule,
    ) -> Result<(), RuleError> {
        if !cwd.is_absolute()
            || cwd
                .components()
                .any(|part| matches!(part, Component::ParentDir))
            || fs::canonicalize(cwd).ok().as_deref() != Some(cwd)
        {
            return Err(RuleError::Invalid);
        }
        let rules = cwd.join(".cursor").join("rules");
        let has_content = rule
            .content
            .as_deref()
            .is_some_and(|value| !value.is_empty());
        if has_content {
            ensure_directory_chain(cwd, &rules)?;
        } else if !rules.exists() {
            return Ok(());
        } else {
            ensure_directory_chain(cwd, &rules)?;
        }
        let target = rules.join(rule.file_name());
        let existing = read_regular(&target)?;
        if existing.as_deref().is_some_and(|value| !rule.owns(value)) {
            return Err(RuleError::Invalid);
        }
        if let Some(content) = rule.content.as_deref().filter(|value| !value.is_empty()) {
            let temporary = rules.join(format!(".rudder-{}.tmp", Uuid::new_v4()));
            let mut options = OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
            let mut file = options.open(&temporary).map_err(|_| RuleError::Invalid)?;
            file.write_all(&rule.rendered(content))
                .map_err(|_| RuleError::Invalid)?;
            file.sync_all().map_err(|_| RuleError::Invalid)?;
            if existing.is_some() {
                fs::remove_file(&target).map_err(|_| RuleError::Invalid)?;
            }
            if let Err(_) = fs::rename(&temporary, &target) {
                let _ = fs::remove_file(&temporary);
                return Err(RuleError::Invalid);
            }
        } else if existing.is_some() {
            fs::remove_file(&target).map_err(|_| RuleError::Invalid)?;
        }
        Ok(())
    }

    fn ensure_directory_chain(root: &Path, target: &Path) -> Result<(), RuleError> {
        let mut current = root.to_path_buf();
        let relative = target.strip_prefix(root).map_err(|_| RuleError::Invalid)?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(RuleError::Invalid);
            };
            current.push(name);
            match fs::symlink_metadata(&current) {
                Ok(metadata)
                    if metadata.is_dir()
                        && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 => {}
                Ok(_) => return Err(RuleError::Invalid),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current).map_err(|_| RuleError::Invalid)?;
                    let metadata =
                        fs::symlink_metadata(&current).map_err(|_| RuleError::Invalid)?;
                    if !metadata.is_dir()
                        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                    {
                        return Err(RuleError::Invalid);
                    }
                }
                Err(_) => return Err(RuleError::Invalid),
            }
        }
        Ok(())
    }

    fn read_regular(path: &Path) -> Result<Option<Vec<u8>>, RuleError> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        match options.open(path) {
            Ok(mut file) => {
                let metadata = file.metadata().map_err(|_| RuleError::Invalid)?;
                if !metadata.is_file()
                    || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                    || metadata.len() > super::MAX_RULE_BYTES as u64
                {
                    return Err(RuleError::Invalid);
                }
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)
                    .map_err(|_| RuleError::Invalid)?;
                Ok(Some(bytes))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(RuleError::Invalid),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_rule(agent: &str, content: Option<&str>) -> CursorManagedInstructionRule {
        CursorManagedInstructionRule {
            agent_id: agent.into(),
            revision: format!("sha256:{}", "a".repeat(64)),
            content: content.map(str::to_owned),
        }
    }

    #[test]
    fn writes_one_namespaced_always_apply_rule_and_replaces_its_revision_in_place() {
        let root = tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let agent = Uuid::new_v4().to_string();
        let first = test_rule(&agent, Some("Follow the managed instructions."));
        materialize(&cwd, &first).unwrap();
        let rule_path = cwd
            .join(".cursor/rules")
            .join(format!("{RULE_PREFIX}{agent}.mdc"));
        let first_body = std::fs::read_to_string(&rule_path).unwrap();
        assert!(first_body.contains("alwaysApply: true"));
        assert!(first_body.contains("Follow the managed instructions."));
        assert_eq!(
            std::fs::read_dir(rule_path.parent().unwrap())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|value| value == "mdc"))
                .count(),
            1
        );
        let actual_rule = std::fs::read_to_string(&rule_path).unwrap();
        assert!(first.owns(actual_rule.as_bytes()));

        let mut second = test_rule(&agent, Some("Updated managed instructions."));
        second.revision = format!("sha256:{}", "b".repeat(64));
        materialize(&cwd, &second).unwrap();
        let second_body = std::fs::read_to_string(&rule_path).unwrap();
        assert!(second_body.contains("Updated managed instructions."));
        assert!(!second_body.contains("Follow the managed instructions."));
        assert_eq!(
            std::fs::read_dir(rule_path.parent().unwrap())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|value| value == "mdc"))
                .count(),
            1,
            "continuations must not accumulate alwaysApply rules"
        );

        let empty = test_rule(&agent, None);
        materialize(&cwd, &empty).unwrap();
        assert!(!rule_path.exists());
    }

    #[test]
    fn refuses_a_foreign_rule_collision_without_replacing_it() {
        let root = tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let agent = Uuid::new_v4().to_string();
        let rules = cwd.join(".cursor/rules");
        std::fs::create_dir_all(&rules).unwrap();
        let path = rules.join(format!("{RULE_PREFIX}{agent}.mdc"));
        std::fs::write(&path, b"operator-owned rule").unwrap();
        assert_eq!(
            materialize(&cwd, &test_rule(&agent, Some("new body"))),
            Err(RuleError::Invalid)
        );
        assert_eq!(std::fs::read(path).unwrap(), b"operator-owned rule");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_rule_directories_and_symlinked_collisions() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let cwd = root.path().join("cwd");
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&elsewhere).unwrap();
        symlink(&elsewhere, cwd.join(".cursor")).unwrap();
        let agent = Uuid::new_v4().to_string();
        assert_eq!(
            materialize(&cwd, &test_rule(&agent, Some("must not write"))),
            Err(RuleError::Invalid)
        );
        assert!(!elsewhere.join("rules").exists());

        let other_cwd = root.path().join("other-cwd");
        std::fs::create_dir_all(other_cwd.join(".cursor/rules")).unwrap();
        let target = elsewhere.join("outside.mdc");
        std::fs::write(&target, b"outside").unwrap();
        symlink(
            &target,
            other_cwd
                .join(".cursor/rules")
                .join(format!("{RULE_PREFIX}{agent}.mdc")),
        )
        .unwrap();
        assert_eq!(
            materialize(&other_cwd, &test_rule(&agent, Some("must not follow"))),
            Err(RuleError::Invalid)
        );
        assert_eq!(std::fs::read(target).unwrap(), b"outside");
    }
}
