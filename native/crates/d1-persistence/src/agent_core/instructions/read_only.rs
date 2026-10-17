//! Bounded, read-only instruction bundle traversal for Native Chat.
//!
//! This module deliberately uses descriptor-relative traversal on supported
//! Unix hosts. It never collects an unbounded list of paths and opens every
//! selected object without following symlinks.

use std::{collections::BTreeMap, io, path::Path};

#[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
const MAX_FILE_BYTES: usize = 1_048_576;
const MAX_BUNDLE_BYTES: usize = 4_194_304;
const MAX_BUNDLE_PATH_BYTES: usize = 4_194_304;
#[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
const MAX_ENTRIES: usize = 4_096;
#[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
const MAX_DEPTH: usize = 64;
const MAX_RELATIVE_PATH_BYTES: usize = 16_384;
type BundleContents = BTreeMap<String, Vec<u8>>;
type ScanOutput<'a> = Option<(&'a mut BundleContents, usize, usize)>;

pub(super) fn file_count(root: &Path, allow_missing: bool) -> io::Result<usize> {
    scan(root, allow_missing, None)
}

pub(super) fn read_bundle(
    root: &Path,
    allow_missing: bool,
    output: &mut BundleContents,
) -> io::Result<()> {
    let current_bytes = output
        .values()
        .try_fold(0usize, |total, value| total.checked_add(value.len()))
        .ok_or_else(limit_error)?;
    let current_path_bytes = output
        .keys()
        .try_fold(0usize, |total, value| total.checked_add(value.len()))
        .ok_or_else(limit_error)?;
    if current_bytes > MAX_BUNDLE_BYTES || current_path_bytes > MAX_BUNDLE_PATH_BYTES {
        return Err(limit_error());
    }
    scan(
        root,
        allow_missing,
        Some((output, current_bytes, current_path_bytes)),
    )
    .map(|_| ())
}

pub(super) fn read_single(path: &Path, existing: &BundleContents) -> io::Result<Option<Vec<u8>>> {
    let current_bytes = existing
        .values()
        .try_fold(0usize, |total, value| total.checked_add(value.len()))
        .ok_or_else(limit_error)?;
    if current_bytes > MAX_BUNDLE_BYTES {
        return Err(limit_error());
    }
    let remaining = MAX_BUNDLE_BYTES - current_bytes;
    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    {
        unix::read_single(path, remaining)
    }
    #[cfg(not(all(unix, any(target_os = "linux", target_os = "macos"))))]
    {
        let _ = remaining;
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                Err(invalid("Legacy instruction entry is not a regular file"))
            }
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Safe Native Chat instruction bundle traversal is unavailable on this platform",
            )),
        }
    }
}

pub(super) fn insert_bounded(
    output: &mut BundleContents,
    key: String,
    bytes: Vec<u8>,
) -> io::Result<()> {
    if output.contains_key(&key) {
        return Ok(());
    }
    let current_bytes = output
        .values()
        .try_fold(0usize, |total, value| total.checked_add(value.len()))
        .ok_or_else(limit_error)?;
    let current_path_bytes = output
        .keys()
        .try_fold(0usize, |total, value| total.checked_add(value.len()))
        .ok_or_else(limit_error)?;
    let next_bytes = current_bytes
        .checked_add(bytes.len())
        .ok_or_else(limit_error)?;
    let next_path_bytes = current_path_bytes
        .checked_add(key.len())
        .ok_or_else(limit_error)?;
    if key.len() > MAX_RELATIVE_PATH_BYTES
        || next_bytes > MAX_BUNDLE_BYTES
        || next_path_bytes > MAX_BUNDLE_PATH_BYTES
    {
        return Err(limit_error());
    }
    output.insert(key, bytes);
    Ok(())
}

fn limit_error() -> io::Error {
    invalid("Instruction bundle exceeds the Native Chat revision limit")
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
fn scan(root: &Path, allow_missing: bool, output: ScanOutput<'_>) -> io::Result<usize> {
    unix::scan(root, allow_missing, output)
}

#[cfg(not(all(unix, any(target_os = "linux", target_os = "macos"))))]
fn scan(root: &Path, allow_missing: bool, _output: ScanOutput<'_>) -> io::Result<usize> {
    match std::fs::symlink_metadata(root) {
        Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(invalid("Instruction bundle root is not a directory"))
        }
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Safe Native Chat instruction bundle traversal is unavailable on this platform",
        )),
    }
}

#[cfg(all(test, not(all(unix, any(target_os = "linux", target_os = "macos")))))]
mod unsupported_platform_tests {
    use super::*;

    #[test]
    fn absent_instructions_are_allowed_but_existing_bundles_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("absent");
        assert_eq!(file_count(&missing, true).unwrap(), 0);
        assert!(
            read_single(&missing, &BundleContents::new())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            file_count(root.path(), true).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        let file = root.path().join("SOUL.md");
        std::fs::write(&file, "private instructions").unwrap();
        assert_eq!(
            read_single(&file, &BundleContents::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );
        let mut contents = BundleContents::new();
        assert_eq!(
            read_bundle(root.path(), false, &mut contents)
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );
        assert!(contents.is_empty());
    }
}

#[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
mod unix {
    use super::{
        BundleContents, MAX_BUNDLE_BYTES, MAX_BUNDLE_PATH_BYTES, MAX_DEPTH, MAX_ENTRIES,
        MAX_FILE_BYTES, MAX_RELATIVE_PATH_BYTES, ScanOutput, invalid, limit_error,
    };
    use std::{
        ffi::{CStr, CString},
        fs::File,
        io::{self, Read},
        os::{fd::FromRawFd, fd::RawFd, unix::ffi::OsStrExt},
        path::{Component, Path},
    };

    const IGNORED_DIRS: [&[u8]; 9] = [
        b".git",
        b".nox",
        b".pytest_cache",
        b".ruff_cache",
        b".tox",
        b".venv",
        b"__pycache__",
        b"node_modules",
        b"venv",
    ];
    const IGNORED_FILES: [&[u8]; 3] = [b".DS_Store", b"Thumbs.db", b"Desktop.ini"];

    struct ScanState<'a> {
        output: Option<&'a mut BundleContents>,
        total_bytes: usize,
        total_path_bytes: usize,
        files: usize,
        entries: usize,
    }

    struct DirStream(*mut libc::DIR);

    impl Drop for DirStream {
        fn drop(&mut self) {
            // fdopendir owns the duplicated descriptor.
            unsafe {
                libc::closedir(self.0);
            }
        }
    }

    impl DirStream {
        fn open(directory: &File) -> io::Result<Self> {
            let fd = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let stream = unsafe { libc::fdopendir(fd) };
            if stream.is_null() {
                let error = io::Error::last_os_error();
                unsafe {
                    libc::close(fd);
                }
                return Err(error);
            }
            Ok(Self(stream))
        }

        fn next_name(&mut self, counted_entries: &mut usize) -> io::Result<Option<Vec<u8>>> {
            loop {
                set_errno(0);
                let entry = unsafe { libc::readdir(self.0) };
                if entry.is_null() {
                    let error = last_errno();
                    return if error == 0 {
                        Ok(None)
                    } else {
                        Err(io::Error::from_raw_os_error(error))
                    };
                }
                // SAFETY: readdir returns a live dirent owned by this stream.
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
                if name == b"." || name == b".." {
                    continue;
                }
                *counted_entries = counted_entries.saturating_add(1);
                if *counted_entries > MAX_ENTRIES {
                    return Err(invalid("Instruction bundle contains too many entries"));
                }
                // Count before copying any name. POSIX filename components
                // are bounded by NAME_MAX, and total relative paths are capped
                // before they are materialized by `walk`.
                return Ok(Some(name.to_vec()));
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn set_errno(value: i32) {
        unsafe { *libc::__errno_location() = value };
    }

    #[cfg(target_os = "macos")]
    fn set_errno(value: i32) {
        unsafe { *libc::__error() = value };
    }

    #[cfg(target_os = "linux")]
    fn last_errno() -> i32 {
        unsafe { *libc::__errno_location() }
    }

    #[cfg(target_os = "macos")]
    fn last_errno() -> i32 {
        unsafe { *libc::__error() }
    }

    use std::os::fd::AsRawFd;

    pub(super) fn scan(
        root: &Path,
        allow_missing: bool,
        output: ScanOutput<'_>,
    ) -> io::Result<usize> {
        let Some(directory) = open_root(root, allow_missing)? else {
            return Ok(0);
        };
        let (contents, total_bytes, total_path_bytes) = match output {
            Some((contents, total_bytes, total_path_bytes)) => {
                (Some(contents), total_bytes, total_path_bytes)
            }
            None => (None, 0, 0),
        };
        let mut state = ScanState {
            output: contents,
            total_bytes,
            total_path_bytes,
            files: 0,
            entries: 0,
        };
        walk(&directory, "", 0, &mut state)?;
        Ok(state.files)
    }

    pub(super) fn read_single(path: &Path, remaining_bytes: usize) -> io::Result<Option<Vec<u8>>> {
        if !path.is_absolute() {
            return Err(invalid("Legacy instruction entry path must be absolute"));
        }
        let parent = path
            .parent()
            .ok_or_else(|| invalid("Legacy instruction entry has no parent directory"))?;
        let name = path
            .file_name()
            .ok_or_else(|| invalid("Legacy instruction entry has no file name"))?;
        let Some(directory) = open_root(parent, true)? else {
            return Ok(None);
        };
        let name = CString::new(name.as_bytes())
            .map_err(|_| invalid("Legacy instruction entry has an invalid file name"))?;
        let kind = match entry_kind(directory.as_raw_fd(), &name) {
            Ok(kind) => kind,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if kind != libc::S_IFREG {
            return Err(invalid(
                "Legacy instruction entry is a symbolic link or unsupported file type",
            ));
        }
        let file = open_regular_at(directory.as_raw_fd(), &name)?;
        read_regular(&file, remaining_bytes).map(Some)
    }

    fn open_root(root: &Path, allow_missing: bool) -> io::Result<Option<File>> {
        if !root.is_absolute() {
            return Err(invalid("Instruction bundle root must be absolute"));
        }
        let slash = CString::new("/").expect("literal has no nul");
        let root_fd = unsafe {
            libc::open(
                slash.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if root_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: open returned a new owned descriptor.
        let mut current = unsafe { File::from_raw_fd(root_fd) };
        for component in root.components() {
            let name = match component {
                Component::RootDir | Component::CurDir => continue,
                Component::Normal(name) => CString::new(name.as_bytes())
                    .map_err(|_| invalid("Instruction bundle root contains an invalid path"))?,
                Component::ParentDir => CString::new("..").expect("literal has no nul"),
                Component::Prefix(_) => {
                    return Err(invalid("Instruction bundle root contains an invalid path"));
                }
            };
            let next_fd = unsafe {
                libc::openat(
                    current.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if next_fd < 0 {
                let error = io::Error::last_os_error();
                if allow_missing && error.kind() == io::ErrorKind::NotFound {
                    return Ok(None);
                }
                if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
                    return Err(invalid(
                        "Instruction bundle root is not a directory or contains a symbolic link",
                    ));
                }
                return Err(error);
            }
            // SAFETY: openat returned a new owned descriptor.
            current = unsafe { File::from_raw_fd(next_fd) };
            ensure_directory(&current)?;
        }
        ensure_directory(&current).map_err(|error| {
            if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
                invalid("Instruction bundle root is not a directory")
            } else {
                error
            }
        })?;
        Ok(Some(current))
    }

    fn ensure_directory(file: &File) -> io::Result<()> {
        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        if unsafe { libc::fstat(file.as_raw_fd(), &mut metadata) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(invalid("Instruction bundle root is not a directory"));
        }
        Ok(())
    }

    fn walk(
        directory: &File,
        relative: &str,
        depth: usize,
        state: &mut ScanState<'_>,
    ) -> io::Result<()> {
        if depth > MAX_DEPTH {
            return Err(invalid("Instruction bundle nesting is too deep"));
        }
        let mut entries = DirStream::open(directory)?;
        while let Some(raw_name) = entries.next_name(&mut state.entries)? {
            if raw_name.is_empty() || raw_name.contains(&0) || raw_name.contains(&b'/') {
                return Err(invalid("Instruction bundle contains an invalid entry name"));
            }
            let name_c = CString::new(raw_name.as_slice())
                .map_err(|_| invalid("Instruction bundle contains an invalid entry name"))?;
            let kind = entry_kind(directory.as_raw_fd(), &name_c)?;
            if kind == libc::S_IFDIR && IGNORED_DIRS.contains(&raw_name.as_slice()) {
                continue;
            }
            let name = entry_name_utf8(&raw_name)?;
            let path_len = relative
                .len()
                .checked_add(usize::from(!relative.is_empty()))
                .and_then(|len| len.checked_add(name.len()))
                .ok_or_else(limit_error)?;
            if path_len > MAX_RELATIVE_PATH_BYTES {
                return Err(invalid(
                    "Instruction bundle paths exceed the Native Chat limit",
                ));
            }
            let relative_name = if relative.is_empty() {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            };
            match kind {
                libc::S_IFDIR => {
                    let child = open_directory_at(directory.as_raw_fd(), &name_c)?;
                    walk(&child, &relative_name, depth + 1, state)?;
                }
                libc::S_IFREG => {
                    let excluded = IGNORED_FILES.contains(&raw_name.as_slice())
                        || raw_name.starts_with(b".rudder-write-probe-")
                        || raw_name.starts_with(b"._")
                        || raw_name.ends_with(b".pyc")
                        || raw_name.ends_with(b".pyo");
                    if excluded {
                        continue;
                    }
                    state.files = state.files.saturating_add(1);
                    if state.files > MAX_ENTRIES {
                        return Err(invalid("Instruction bundle contains too many files"));
                    }
                    let is_duplicate = state
                        .output
                        .as_ref()
                        .is_some_and(|contents| contents.contains_key(&relative_name));
                    let file = open_regular_at(directory.as_raw_fd(), &name_c)?;
                    if let Some(contents) = state.output.as_deref_mut()
                        && !is_duplicate
                    {
                        let remaining = MAX_BUNDLE_BYTES.saturating_sub(state.total_bytes);
                        let bytes = read_regular(&file, remaining)?;
                        let next_total_bytes = state
                            .total_bytes
                            .checked_add(bytes.len())
                            .ok_or_else(limit_error)?;
                        let next_path_bytes = state
                            .total_path_bytes
                            .checked_add(relative_name.len())
                            .ok_or_else(limit_error)?;
                        if next_total_bytes > MAX_BUNDLE_BYTES
                            || next_path_bytes > MAX_BUNDLE_PATH_BYTES
                        {
                            return Err(limit_error());
                        }
                        state.total_bytes = next_total_bytes;
                        state.total_path_bytes = next_path_bytes;
                        contents.insert(relative_name, bytes);
                    }
                }
                _ => {
                    return Err(invalid(
                        "Instruction bundle contains a symbolic link or unsupported file type",
                    ));
                }
            }
        }
        Ok(())
    }

    fn entry_kind(directory: RawFd, name: &CString) -> io::Result<libc::mode_t> {
        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        if unsafe {
            libc::fstatat(
                directory,
                name.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(metadata.st_mode & libc::S_IFMT)
    }

    fn entry_name_utf8(name: &[u8]) -> io::Result<&str> {
        std::str::from_utf8(name)
            .map_err(|_| invalid("Instruction bundle contains a non-UTF-8 entry name"))
    }

    fn open_directory_at(directory: RawFd, name: &CString) -> io::Result<File> {
        let fd = unsafe {
            libc::openat(
                directory,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(map_race_error(io::Error::last_os_error()));
        }
        // SAFETY: openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        ensure_directory(&file).map_err(map_race_error)?;
        Ok(file)
    }

    fn open_regular_at(directory: RawFd, name: &CString) -> io::Result<File> {
        let fd = unsafe {
            libc::openat(
                directory,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(map_race_error(io::Error::last_os_error()));
        }
        // SAFETY: openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(map_race_error)?;
        if !metadata.is_file() {
            return Err(invalid(
                "Instruction bundle contains a symbolic link or unsupported file type",
            ));
        }
        Ok(file)
    }

    fn read_regular(file: &File, remaining_bundle_bytes: usize) -> io::Result<Vec<u8>> {
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(invalid("Instruction bundle changed during read"));
        }
        if metadata.len() > MAX_FILE_BYTES as u64 {
            return Err(limit_error());
        }
        let read_limit = MAX_FILE_BYTES.min(remaining_bundle_bytes);
        read_bounded(file, read_limit)
    }

    fn read_bounded(mut reader: impl Read, limit: usize) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(limit.saturating_add(1));
        reader
            .by_ref()
            .take(limit.saturating_add(1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(limit_error());
        }
        Ok(bytes)
    }

    fn map_race_error(error: io::Error) -> io::Error {
        if error.raw_os_error() == Some(libc::ELOOP) || error.raw_os_error() == Some(libc::ENOTDIR)
        {
            invalid("Instruction bundle changed to a symbolic link or invalid file type")
        } else if error.kind() == io::ErrorKind::NotFound {
            invalid("Instruction bundle changed during read")
        } else {
            error
        }
    }

    #[cfg(test)]
    mod tests {
        use super::super::file_count;
        use super::*;
        use std::{
            cell::Cell,
            collections::BTreeMap,
            fs,
            io::{self, Read, Write},
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
            rc::Rc,
        };

        struct CountingReader {
            remaining: usize,
            reads: Rc<Cell<usize>>,
        }

        impl Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let count = buffer.len().min(self.remaining);
                buffer[..count].fill(b'x');
                self.remaining -= count;
                self.reads.set(self.reads.get() + count);
                Ok(count)
            }
        }

        #[test]
        fn bounded_reader_consumes_at_most_limit_plus_one() {
            let reads = Rc::new(Cell::new(0));
            let reader = CountingReader {
                remaining: usize::MAX,
                reads: reads.clone(),
            };
            let error = read_bounded(reader, MAX_FILE_BYTES)
                .expect_err("limit plus one byte is enough to reject the file");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(reads.get(), MAX_FILE_BYTES + 1);
        }

        #[test]
        fn sparse_oversized_file_is_rejected_from_open_handle_metadata() {
            let directory = tempfile::tempdir().expect("temp directory");
            let root_path = directory
                .path()
                .canonicalize()
                .expect("canonical temp root");
            let path = root_path.join("large.md");
            let file = fs::File::create(&path).expect("create sparse file");
            file.set_len((MAX_FILE_BYTES as u64) + 1)
                .expect("extend sparse file");
            drop(file);
            let directory = open_root(&root_path, false)
                .expect("open trusted temp root")
                .expect("root exists");
            let name = CString::new("large.md").expect("literal name");
            let file = open_regular_at(directory.as_raw_fd(), &name).expect("open regular file");
            let error = read_regular(&file, MAX_BUNDLE_BYTES)
                .expect_err("sparse file exceeds one-file bound");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            let error = super::super::read_single(path.as_path(), &BTreeMap::new())
                .expect_err("legacy single-file read uses the same bound");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }

        #[test]
        fn nofollow_open_rejects_a_regular_to_symlink_swap() {
            let directory = tempfile::tempdir().expect("temp directory");
            let root_path = directory
                .path()
                .canonicalize()
                .expect("canonical temp root");
            let source = root_path.join("entry.md");
            let outside = root_path.join("outside.md");
            fs::write(&source, "before").expect("create regular entry");
            fs::write(&outside, "outside").expect("create target");
            let root = open_root(&root_path, false)
                .expect("open trusted temp root")
                .expect("root exists");
            let name = CString::new("entry.md").expect("literal name");
            assert_eq!(
                entry_kind(root.as_raw_fd(), &name).expect("classify file"),
                libc::S_IFREG
            );
            fs::remove_file(&source).expect("remove classified regular entry");
            std::os::unix::fs::symlink(&outside, &source).expect("replace with symlink");
            let error = open_regular_at(root.as_raw_fd(), &name)
                .expect_err("no-follow open rejects swapped symlink");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }

        #[test]
        fn scan_counts_directories_and_rejects_special_files() {
            let directory = tempfile::tempdir().expect("temp directory");
            for index in 0..MAX_ENTRIES {
                fs::create_dir(directory.path().join(format!("d-{index}")))
                    .expect("create bounded directory entry");
            }
            let root_path = directory
                .path()
                .canonicalize()
                .expect("canonical temp root");
            assert_eq!(file_count(&root_path, false).expect("scan at cap"), 0);
            fs::create_dir(directory.path().join("overflow"))
                .expect("create over-limit directory entry");
            let error = file_count(&root_path, false).expect_err("entry cap applies to dirs");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);

            let special_directory = tempfile::tempdir().expect("special-file temp directory");
            let special = special_directory.path().join("pipe");
            let c_path =
                CString::new(special.as_os_str().as_bytes()).expect("temp path has no nul");
            assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
            let special_root = special_directory
                .path()
                .canonicalize()
                .expect("canonical special-file temp root");
            let error = file_count(&special_root, false)
                .expect_err("FIFO is rejected rather than opened or ignored");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }

        #[test]
        fn scan_rejects_symlink_and_non_utf8_names() {
            let directory = tempfile::tempdir().expect("temp directory");
            let target = directory.path().join("target.md");
            fs::write(&target, "target").expect("write target");
            let link = directory.path().join("link.md");
            std::os::unix::fs::symlink(&target, &link).expect("create symbolic link");
            let root_path = directory
                .path()
                .canonicalize()
                .expect("canonical temp root");
            let error = file_count(&root_path, false).expect_err("symlink rejected");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            fs::remove_file(&link).expect("remove symlink");

            let root_link = root_path.join("bundle-root-link");
            std::os::unix::fs::symlink(&root_path, &root_link)
                .expect("create symbolic link as bundle root");
            let error = file_count(&root_link, false).expect_err("root symlink rejected");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            fs::remove_file(&root_link).expect("remove root symlink");

            let error = entry_name_utf8(&[0xff])
                .expect_err("non-UTF-8 names cannot enter identity hashing");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(
                entry_name_utf8("你好.md".as_bytes()).expect("valid UTF-8"),
                "你好.md"
            );
        }

        #[test]
        fn bundle_limit_bounds_aggregate_content_across_files() {
            let directory = tempfile::tempdir().expect("temp directory");
            for index in 0..4 {
                let path = directory.path().join(format!("part-{index}.md"));
                let file = fs::File::create(path).expect("create sparse bounded file");
                file.set_len(MAX_FILE_BYTES as u64)
                    .expect("extend sparse bounded file");
            }
            let mut output = BTreeMap::new();
            let root_path = directory
                .path()
                .canonicalize()
                .expect("canonical temp root");
            super::super::read_bundle(&root_path, false, &mut output)
                .expect("four one-megabyte files fit aggregate cap");
            assert_eq!(
                output.values().map(Vec::len).sum::<usize>(),
                MAX_BUNDLE_BYTES
            );

            let mut fifth = fs::File::create(directory.path().join("fifth.md"))
                .expect("create aggregate overflow file");
            fifth
                .write_all(b"x")
                .expect("write aggregate overflow byte");
            let error = super::super::read_bundle(&root_path, false, &mut output)
                .expect_err("fifth byte beyond aggregate cap is rejected");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(
                output.values().map(Vec::len).sum::<usize>(),
                MAX_BUNDLE_BYTES
            );
        }
    }
}
