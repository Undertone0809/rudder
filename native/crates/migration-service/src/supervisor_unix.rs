//! Managed-parent supervision on Unix.
//!
//! A child observes its direct parent through `getppid()`. When the parent is
//! killed, the kernel reparents the child, so the identity changes without
//! polling a numeric PID that could later be reused.

use std::{io, time::Duration};

const SUPERVISOR_PID_ENV: &str = "RUDDER_MIGRATION_APPLY_SUPERVISOR_PID";

pub struct ParentProcessMonitor {
    parent_pid: u32,
}

impl ParentProcessMonitor {
    /// Read the optional managed parent PID and prove it is this process's
    /// current direct parent. A missing variable preserves standalone CLI use;
    /// malformed or mismatched managed identity fails closed.
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
        let parent_pid = value.parse::<u32>().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid migration supervisor PID",
            )
        })?;
        if parent_pid == 0 || parent_pid == std::process::id() || current_parent_pid() != parent_pid
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "migration supervisor is not the direct parent",
            ));
        }
        Ok(Some(Self { parent_pid }))
    }

    /// Poll the kernel-reported parent identity without blocking the async
    /// runtime. Reparenting cannot produce the original PID again while the
    /// original parent process object remains alive; no `kill(pid, 0)` lookup
    /// is used, so PID reuse cannot conceal parent death.
    pub async fn wait_for_exit(&self) -> io::Result<()> {
        loop {
            if self.has_exited() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Check the current direct-parent identity synchronously to resolve a
    /// parent-exit race against an already-completed stdin or database future.
    pub fn has_exited(&self) -> bool {
        current_parent_pid() != self.parent_pid
    }
}

fn current_parent_pid() -> u32 {
    // POSIX guarantees a positive parent PID for a running process.
    unsafe { libc::getppid() as u32 }
}
