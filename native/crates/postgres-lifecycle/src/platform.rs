use crate::error::OwnerError;
use std::fs::Metadata;
#[cfg(windows)]
use std::io;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DirectoryIdentity {
    device: u64,
    inode: u64,
}

/// Return a stable OS identity for a directory where the platform exposes
/// one. Publication code must fail closed when identity cannot be obtained.
pub(crate) fn directory_identity(path: &Path, metadata: &Metadata) -> Option<DirectoryIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return None;
        }
        Some(DirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::{os::windows::ffi::OsStrExt, ptr};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
                FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING,
            },
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return None;
        }
        let path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        let read = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
        unsafe { CloseHandle(handle) };
        if !read
            || information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return None;
        }
        Some(DirectoryIdentity {
            device: u64::from(information.dwVolumeSerialNumber),
            inode: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        let _ = metadata;
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessIdStatus {
    Present,
    Absent,
    Unknown,
}

/// Report only whether the PID number is definitely live or definitely absent.
/// Callers must preserve PGDATA when the operating system cannot decide.
pub(crate) fn process_id_status(pid: u32) -> ProcessIdStatus {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return ProcessIdStatus::Unknown;
        };
        if unsafe { libc::kill(pid, 0) } == 0 {
            return ProcessIdStatus::Present;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => ProcessIdStatus::Absent,
            Some(libc::EPERM) => ProcessIdStatus::Present,
            _ => ProcessIdStatus::Unknown,
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0, WAIT_TIMEOUT,
            },
            System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                ProcessIdStatus::Absent
            } else {
                ProcessIdStatus::Unknown
            };
        }
        let status = unsafe { WaitForSingleObject(handle, 0) };
        unsafe { CloseHandle(handle) };
        match status {
            WAIT_OBJECT_0 => ProcessIdStatus::Absent,
            WAIT_TIMEOUT => ProcessIdStatus::Present,
            _ => ProcessIdStatus::Unknown,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        ProcessIdStatus::Unknown
    }
}

#[derive(Debug)]
pub(crate) struct ParentMonitor {
    expected: Option<u32>,
    #[cfg(windows)]
    handle: Option<usize>,
}

impl ParentMonitor {
    pub(crate) fn new(expected: Option<u32>) -> Result<Self, OwnerError> {
        if let Some(pid) = expected
            && (pid == 0 || pid == std::process::id() || current_parent_pid() != pid)
        {
            return Err(OwnerError::new(
                "invalid_parent",
                "parent_pid is not the direct parent of the PostgreSQL owner",
            ));
        }
        #[cfg(windows)]
        let handle = if let Some(pid) = expected {
            use windows_sys::Win32::{
                Foundation::WAIT_OBJECT_0,
                System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
            };
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                return Err(OwnerError::io(
                    "invalid_parent",
                    "cannot monitor PostgreSQL owner parent",
                    io::Error::last_os_error(),
                ));
            }
            let result = unsafe { WaitForSingleObject(handle, 0) };
            if result == WAIT_OBJECT_0 {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
                return Err(OwnerError::new(
                    "invalid_parent",
                    "PostgreSQL owner parent already exited",
                ));
            }
            Some(handle as usize)
        } else {
            None
        };
        #[cfg(windows)]
        install_windows_process_job()?;
        Ok(Self {
            expected,
            #[cfg(windows)]
            handle,
        })
    }

    pub(crate) fn has_exited(&self) -> bool {
        #[cfg(unix)]
        {
            let Some(expected) = self.expected else {
                return false;
            };
            current_parent_pid() != expected
        }
        #[cfg(windows)]
        {
            if self.expected.is_none() {
                return false;
            }
            use windows_sys::Win32::{
                Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            let Some(handle) = self.handle else {
                return true;
            };
            match unsafe { WaitForSingleObject(handle as _, 0) } {
                WAIT_OBJECT_0 => true,
                WAIT_TIMEOUT => false,
                WAIT_FAILED => true,
                _ => true,
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = self.expected;
            false
        }
    }

    pub(crate) fn ensure_alive(&self) -> Result<(), OwnerError> {
        if self.has_exited() {
            Err(OwnerError::new(
                "parent_exited",
                "supervising process exited during PostgreSQL startup",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(unix)]
pub(crate) fn current_parent_pid() -> u32 {
    unsafe { libc::getppid() as u32 }
}

#[cfg(windows)]
pub(crate) fn current_parent_pid() -> u32 {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        System::Threading::GetCurrentProcessId,
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return 0;
    }
    let current = unsafe { GetCurrentProcessId() };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut parent = 0;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID == current {
            parent = entry.th32ParentProcessID;
            break;
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    parent
}

#[cfg(windows)]
fn install_windows_process_job() -> Result<(), OwnerError> {
    use std::{mem, ptr, sync::OnceLock};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::GetCurrentProcess,
        },
    };
    static JOB: OnceLock<Result<usize, i32>> = OnceLock::new();
    let result = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return Err(io::Error::last_os_error().raw_os_error().unwrap_or(-1));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(error.raw_os_error().unwrap_or(-1));
        }
        // Keep the non-inherited handle open until process teardown. Windows
        // closes it after the owner exits, terminating any surviving children.
        Ok(job as usize)
    });
    match result {
        Ok(_job) => Ok(()),
        Err(code) => Err(OwnerError::new(
            "process_tree_unavailable",
            format!("cannot install Windows PostgreSQL child job (OS error {code})"),
        )),
    }
}

#[cfg(windows)]
impl Drop for ParentMonitor {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle as _) };
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn current_parent_pid() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn pid_status_distinguishes_present_and_absent_without_guessing() {
        assert_eq!(
            process_id_status(std::process::id()),
            ProcessIdStatus::Present
        );
        assert_eq!(process_id_status(i32::MAX as u32), ProcessIdStatus::Absent);
        assert_eq!(process_id_status(u32::MAX), ProcessIdStatus::Unknown);
    }

    #[test]
    fn standalone_parent_monitor_is_live_without_a_supervisor() {
        let monitor = ParentMonitor::new(None).unwrap();
        assert!(!monitor.has_exited());
        monitor.ensure_alive().unwrap();
    }
}
