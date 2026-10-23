use crate::error::OwnerError;
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize)]
pub(crate) struct LeaseMetadata<'a> {
    pub(crate) schema: &'static str,
    pub(crate) lease_id: &'a str,
    pub(crate) instance_id: &'a str,
    pub(crate) owner_pid: u32,
    pub(crate) data_dir: &'a Path,
    pub(crate) port: u16,
    pub(crate) owned: bool,
}

#[derive(Debug)]
pub(crate) struct LeaseLock {
    file: File,
    path: PathBuf,
}

impl LeaseLock {
    pub(crate) fn acquire(data_dir: &Path) -> Result<Self, OwnerError> {
        let parent = data_dir
            .parent()
            .ok_or_else(|| OwnerError::new("invalid_data_dir", "data_dir has no parent"))?;
        let name = data_dir
            .file_name()
            .ok_or_else(|| OwnerError::new("invalid_data_dir", "data_dir has no name"))?;
        let mut lock_name = std::ffi::OsString::from(".");
        lock_name.push(name);
        lock_name.push(".rudder-postgres-owner.lock");
        let path = parent.join(lock_name);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| {
                OwnerError::io(
                    "owner_lock_failed",
                    "cannot open PostgreSQL ownership lock",
                    error,
                )
            })?;
        lock_file_exclusive(&file).map_err(|error| {
            if lock_is_busy(&error) {
                OwnerError::new(
                    "owner_busy",
                    "another PostgreSQL owner holds the data-directory lease",
                )
            } else {
                OwnerError::io(
                    "owner_lock_failed",
                    "cannot acquire PostgreSQL ownership lock",
                    error,
                )
            }
        })?;
        Ok(Self { file, path })
    }

    pub(crate) fn write_metadata(
        &mut self,
        metadata: &LeaseMetadata<'_>,
    ) -> Result<(), OwnerError> {
        let bytes = serde_json::to_vec(metadata).map_err(|_| {
            OwnerError::new(
                "owner_lock_failed",
                "cannot encode PostgreSQL lease metadata",
            )
        })?;
        self.file
            .set_len(0)
            .and_then(|_| self.file.seek(SeekFrom::Start(0)))
            .and_then(|_| self.file.write_all(&bytes))
            .and_then(|_| self.file.sync_all())
            .map_err(|error| {
                OwnerError::io(
                    "owner_lock_failed",
                    "cannot persist PostgreSQL lease metadata",
                    error,
                )
            })
    }

    pub(crate) fn clear_metadata(&mut self) -> Result<(), OwnerError> {
        self.file
            .set_len(0)
            .and_then(|_| self.file.sync_all())
            .map_err(|error| {
                OwnerError::io(
                    "owner_lock_failed",
                    "cannot clear PostgreSQL lease metadata",
                    error,
                )
            })
    }
}

impl Drop for LeaseLock {
    fn drop(&mut self) {
        let _ = &self.path;
        unlock_file(&self.file);
    }
}

#[cfg(unix)]
fn lock_file_exclusive(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) {
    use std::os::fd::AsRawFd;
    let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
}

#[cfg(unix)]
fn lock_is_busy(error: &io::Error) -> bool {
    error
        .raw_os_error()
        .is_some_and(|code| code == libc::EWOULDBLOCK || code == libc::EAGAIN)
}

#[cfg(windows)]
fn lock_file_exclusive(file: &File) -> io::Result<()> {
    use std::{mem, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx},
        System::IO::OVERLAPPED,
    };
    let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
    let result = unsafe {
        LockFileEx(
            file.as_raw_handle() as _,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn unlock_file(file: &File) {
    use std::{mem, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{Storage::FileSystem::UnlockFileEx, System::IO::OVERLAPPED};
    let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
    let _ = unsafe { UnlockFileEx(file.as_raw_handle() as _, 0, 1, 0, &mut overlapped) };
}

#[cfg(windows)]
fn lock_is_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(33) // ERROR_LOCK_VIOLATION
}

#[cfg(not(any(unix, windows)))]
fn lock_file_exclusive(_file: &File) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "OS file locking is unsupported",
    ))
}

#[cfg(not(any(unix, windows)))]
fn unlock_file(_file: &File) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn ownership_lock_is_exclusive_and_released_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("cluster");
        let lock = LeaseLock::acquire(&data_dir).unwrap();
        assert_eq!(
            LeaseLock::acquire(&data_dir).unwrap_err().code,
            "owner_busy"
        );
        drop(lock);
        assert!(LeaseLock::acquire(&data_dir).is_ok());
    }
}
