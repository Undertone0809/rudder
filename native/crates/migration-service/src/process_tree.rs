//! Windows process-tree cleanup for the explicit migration operator.
//!
//! `std::process::Child::kill` maps to `TerminateProcess` on Windows, which
//! cannot be handled by Tokio's Ctrl+C listener and does not wait for child
//! processes. A kill-on-close Job Object makes the kernel terminate descendants
//! when the operator exits abruptly and closes its non-inherited job handle.

use std::{io, mem, ptr, sync::OnceLock, time::Duration};
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Threading::{
            GetCurrentProcess, GetCurrentProcessId, OpenProcess, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        },
    },
};

const SUPERVISOR_PID_ENV: &str = "RUDDER_MIGRATION_APPLY_SUPERVISOR_PID";

/// Retains the non-inherited job handle for the lifetime of the process.
///
/// Processes started by this operator join the job by default. Closing the
/// last job handle terminates every still-running process in it, including
/// when Windows tears down this process after an external `TerminateProcess`.
/// The raw handle is deliberately not closed by Rust `Drop`: this job includes
/// the operator itself, so closing it before the CLI finishes emitting its
/// response would terminate the operator. Windows closes the handle during
/// process teardown, after the response has been written.
struct ProcessTreeGuard {
    // Keep a Rust-side token to document that the OS job handle stays open.
    // This value is deliberately never passed to CloseHandle after assignment.
    _job: usize,
}

static PROCESS_TREE_GUARD: OnceLock<Result<ProcessTreeGuard, io::ErrorKind>> = OnceLock::new();

impl ProcessTreeGuard {
    /// Create the cleanup job and assign the current process to it.
    ///
    /// This must run before starting work that may create external processes.
    /// Failure is returned to the CLI, which refuses to continue.
    fn install() -> io::Result<Self> {
        // A null security descriptor and name create a private unnamed object;
        // the returned handle is not inheritable by child processes.
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }

        let assigned = unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) };
        if assigned == 0 {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }

        Ok(Self { _job: job as usize })
    }
}

/// Ensure a kill-on-close job is installed once for this process.
///
/// The result is cached because startup can reach the migration operator
/// through either the standalone CLI or the native server foundation. Once
/// assigned, the handle remains open in the process handle table until Windows
/// tears the process down and closes it.
pub fn ensure_installed() -> io::Result<()> {
    match PROCESS_TREE_GUARD
        .get_or_init(|| ProcessTreeGuard::install().map_err(|error| error.kind()))
    {
        Ok(_guard) => Ok(()),
        Err(kind) => Err(io::Error::new(*kind, "process-tree job unavailable")),
    }
}

/// A stable handle to the managed parent process. Waiting on the handle keeps
/// observing that process object even after Windows reuses its numeric PID.
pub struct ParentProcessMonitor {
    handle: usize,
}

impl ParentProcessMonitor {
    /// Read and open the optional managed parent identity. A missing variable
    /// means this is an independently invoked operator; malformed, dead, or
    /// unmonitorable parents are errors so managed startup fails closed.
    pub fn from_env() -> io::Result<Option<Self>> {
        let Some(value) = std::env::var_os(SUPERVISOR_PID_ENV) else {
            return Ok(None);
        };
        let value = value.into_string().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid migration supervisor PID",
            )
        })?;
        let pid = value.parse::<u32>().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid migration supervisor PID",
            )
        })?;
        Self::open(pid).map(Some)
    }

    fn open(pid: u32) -> io::Result<Self> {
        if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid migration supervisor PID",
            ));
        }
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let monitor = Self {
            handle: handle as usize,
        };
        match monitor.poll()? {
            true => Err(io::Error::new(
                io::ErrorKind::NotFound,
                "migration supervisor has already exited",
            )),
            false => Ok(monitor),
        }
    }

    /// Poll the process object without blocking the async runtime.
    pub async fn wait_for_exit(&self) -> io::Result<()> {
        loop {
            if self.poll()? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Synchronously check whether the managed parent has exited.
    ///
    /// This resolves the race where the operator's work completes at the same
    /// time as its parent. Unlike Unix's `getppid` comparison, Windows polls a
    /// process handle and can fail; callers must treat that error as a monitor
    /// failure rather than accepting the completed operation.
    pub fn has_exited(&self) -> io::Result<bool> {
        self.poll()
    }

    fn poll(&self) -> io::Result<bool> {
        let result = unsafe { WaitForSingleObject(self.handle as _, 0) };
        match result {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected supervisor wait result")),
        }
    }
}

impl Drop for ParentProcessMonitor {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle as _) };
    }
}

#[cfg(test)]
mod tests {
    use super::ParentProcessMonitor;

    #[test]
    fn synchronous_exit_poll_reports_invalid_handle_errors() {
        let monitor = ParentProcessMonitor { handle: 0 };
        assert!(monitor.has_exited().is_err());
    }
}
