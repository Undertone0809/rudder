use crate::error::OwnerError;
use std::{
    io, mem,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::INVALID_HANDLE_VALUE,
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    },
};

// std's primary-thread handle API is unstable. A freshly CREATE_SUSPENDED
// process has not executed its entry point, so its one thread is found by PID.
pub(super) fn resume_suspended_child(pid: u32) -> Result<(), OwnerError> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(start_error("cannot inspect suspended PostgreSQL launcher"));
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = THREADENTRY32 {
        dwSize: mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(start_error(
                    "cannot open suspended PostgreSQL launcher thread",
                ));
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(start_error("cannot resume supervised PostgreSQL launcher"));
            }
            return Ok(());
        }
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(OwnerError::new(
        "postgres_start_failed",
        "suspended PostgreSQL launcher thread was not found",
    ))
}

fn start_error(message: &str) -> OwnerError {
    OwnerError::io("postgres_start_failed", message, io::Error::last_os_error())
}

#[cfg(test)]
mod tests {
    use crate::process::{ChildJob, configure_child_process, supervised_spawn};
    use std::{path::Path, time::Duration};
    use tokio::process::Command;

    #[test]
    fn suspended_child_fixture() {
        if let Some(marker) = std::env::var_os("RUDDER_SUSPENDED_CHILD_MARKER") {
            std::fs::write(marker, "ran").unwrap();
        }
    }

    fn fixture(marker: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process::windows_spawn::tests::suspended_child_fixture",
            ])
            .env("RUDDER_SUSPENDED_CHILD_MARKER", marker);
        command
    }

    #[tokio::test]
    async fn launcher_waits_for_job_assignment_and_job_close_cleans_it() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("executed");
        let mut command = fixture(&marker);
        configure_child_process(&mut command).unwrap();
        let mut child = command.spawn().unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!marker.exists(), "launcher ran before job assignment");
        let job = ChildJob::assign(&child).unwrap();
        assert!(job.active_processes().unwrap());
        drop(job);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(
            !marker.exists(),
            "failed-start cleanup resumed the launcher"
        );
    }

    #[tokio::test]
    async fn supervised_launcher_resumes_after_assignment() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("executed");
        let mut process = supervised_spawn(&mut fixture(&marker)).unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            process.wait_tree_exit(Duration::from_secs(5)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "ran");
    }
}
