#![cfg(windows)]

//! Black-box Windows coverage for abrupt parent termination. `Child::kill`
//! uses TerminateProcess here, so the parent cannot run Rust destructors; the
//! descendant must be cleaned up by the kernel Job Object instead.

use std::{
    env,
    fs::{self, File},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0},
    System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
    },
};

const HELPER_MODE: &str = "RUDDER_MIGRATION_PROCESS_TREE_HELPER";
const PID_FILE: &str = "RUDDER_MIGRATION_PROCESS_TREE_PID_FILE";
const CHAIN_MODE: &str = "RUDDER_MIGRATION_SUPERVISOR_CHAIN_HELPER";
const SUPERVISOR_PID: &str = "RUDDER_MIGRATION_APPLY_SUPERVISOR_PID";
const OPERATOR_PID_FILE: &str = "RUDDER_MIGRATION_SUPERVISOR_OPERATOR_PID_FILE";
const DUMP_PID_FILE: &str = "RUDDER_MIGRATION_SUPERVISOR_DUMP_PID_FILE";
const GRANDCHILD_PID_FILE: &str = "RUDDER_MIGRATION_SUPERVISOR_GRANDCHILD_PID_FILE";
const CLI_STDOUT_FILE: &str = "RUDDER_MIGRATION_SUPERVISOR_CLI_STDOUT_FILE";
const CLI_STDERR_FILE: &str = "RUDDER_MIGRATION_SUPERVISOR_CLI_STDERR_FILE";

#[test]
fn guarded_parent_helper() {
    if env::var(HELPER_MODE).as_deref() != Ok("parent") {
        return;
    }

    rudder_migration_service::ensure_process_tree_guard()
        .expect("test parent installs the same process-tree guard as the operator");
    rudder_migration_service::ensure_process_tree_guard()
        .expect("installing the process-wide guard is idempotent");
    let pid_file = env::var_os(PID_FILE).expect("test supplies a PID file");
    let descendant = Command::new(env::current_exe().unwrap())
        .args(["--exact", "guarded_leaf_helper", "--nocapture"])
        .env(HELPER_MODE, "leaf")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test descendant inside the job");
    fs::write(pid_file, descendant.id().to_string()).expect("publish descendant PID");

    // Dropping std::process::Child closes only the parent's process handle and
    // does not kill the child. Keep the helper alive until the test terminates
    // it from outside with TerminateProcess.
    drop(descendant);
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn guarded_leaf_helper() {
    if env::var(HELPER_MODE).as_deref() != Ok("leaf") {
        return;
    }
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn abrupt_operator_termination_kills_descendant_process() {
    let temp = tempfile::tempdir().unwrap();
    let pid_file = temp.path().join("descendant.pid");
    let mut parent = Command::new(env::current_exe().unwrap())
        .args(["--exact", "guarded_parent_helper", "--nocapture"])
        .env(HELPER_MODE, "parent")
        .env(PID_FILE, &pid_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn guarded parent process");

    let started = Instant::now();
    while !pid_file.is_file() {
        if let Some(status) = parent.try_wait().unwrap() {
            let stderr = parent
                .wait_with_output()
                .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
                .unwrap_or_default();
            panic!("guarded parent exited before publishing descendant PID ({status}): {stderr}");
        }
        if started.elapsed() > Duration::from_secs(15) {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("guarded parent did not publish descendant PID");
        }
        thread::sleep(Duration::from_millis(20));
    }

    let descendant_pid: u32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .expect("valid descendant PID");
    let descendant_handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, descendant_pid) };
    assert!(
        !descendant_handle.is_null(),
        "descendant process is alive before parent termination"
    );

    // On Windows std::process::Child::kill is TerminateProcess. This bypasses
    // Tokio signal handling and Rust Drop, exercising the failure case that
    // motivated the job-object boundary.
    parent.kill().expect("terminate guarded parent abruptly");
    let parent_status = parent.wait().expect("wait for terminated parent");
    assert!(!parent_status.success(), "parent was terminated externally");

    let descendant_exit = unsafe { WaitForSingleObject(descendant_handle, 10_000) };
    unsafe { CloseHandle(descendant_handle) };
    assert_eq!(
        descendant_exit, WAIT_OBJECT_0,
        "kill-on-close job must terminate the still-running descendant"
    );
}

#[test]
fn managed_supervisor_helper() {
    if env::var(CHAIN_MODE).as_deref() != Ok("parent") {
        return;
    }

    let current_exe = env::current_exe().unwrap();
    let operator_pid_file = env::var_os(OPERATOR_PID_FILE).expect("operator PID file");
    let dump_pid_file = env::var_os(DUMP_PID_FILE).expect("dump PID file");
    let grandchild_pid_file = env::var_os(GRANDCHILD_PID_FILE).expect("grandchild PID file");
    let operator = Command::new(current_exe)
        .args(["--exact", "managed_operator_helper", "--nocapture"])
        .env(CHAIN_MODE, "operator")
        .env(SUPERVISOR_PID, std::process::id().to_string())
        .env(OPERATOR_PID_FILE, operator_pid_file)
        .env(DUMP_PID_FILE, dump_pid_file)
        .env(GRANDCHILD_PID_FILE, grandchild_pid_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn managed migration operator helper");
    fs::write(
        env::var_os(OPERATOR_PID_FILE).unwrap(),
        operator.id().to_string(),
    )
    .expect("publish operator PID");
    drop(operator);
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[tokio::test]
async fn managed_operator_helper() {
    if env::var(CHAIN_MODE).as_deref() != Ok("operator") {
        return;
    }

    rudder_migration_service::ensure_process_tree_guard()
        .expect("managed operator installs the production job guard");
    let supervisor = rudder_migration_service::ParentProcessMonitor::from_env()
        .expect("managed parent handle is available")
        .expect("helper receives a managed parent PID");
    assert_eq!(
        supervisor
            .has_exited()
            .expect("synchronous parent process poll should succeed"),
        false,
        "managed parent should still be alive before its operator is killed"
    );
    let dump = Command::new(env::current_exe().unwrap())
        .args(["--exact", "managed_dump_helper", "--nocapture"])
        .env(CHAIN_MODE, "dump")
        .env(DUMP_PID_FILE, env::var_os(DUMP_PID_FILE).unwrap())
        .env(
            GRANDCHILD_PID_FILE,
            env::var_os(GRANDCHILD_PID_FILE).unwrap(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pg_dump-shaped descendant");
    fs::write(env::var_os(DUMP_PID_FILE).unwrap(), dump.id().to_string())
        .expect("publish dump PID");
    drop(dump);

    // The real CLI races this same process-object wait against its apply
    // future. Once the managed parent dies, it returns, drops its job handle,
    // and Windows terminates both the dump-shaped child and grandchild.
    supervisor
        .wait_for_exit()
        .await
        .expect("wait on the opened parent process object");
    assert!(
        supervisor
            .has_exited()
            .expect("synchronous parent process poll should succeed after exit"),
        "synchronous poll should observe the exited parent"
    );
}

#[test]
fn managed_dump_helper() {
    if env::var(CHAIN_MODE).as_deref() != Ok("dump") {
        return;
    }

    let grandchild = Command::new(env::current_exe().unwrap())
        .args(["--exact", "managed_leaf_helper", "--nocapture"])
        .env(CHAIN_MODE, "leaf")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pg_dump grandchild helper");
    fs::write(
        env::var_os(GRANDCHILD_PID_FILE).unwrap(),
        grandchild.id().to_string(),
    )
    .expect("publish grandchild PID");
    drop(grandchild);
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn managed_leaf_helper() {
    if env::var(CHAIN_MODE).as_deref() != Ok("leaf") {
        return;
    }
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn managed_cli_parent_helper() {
    if env::var(CHAIN_MODE).as_deref() != Ok("cli-parent") {
        return;
    }

    let operator_pid_file = env::var_os(OPERATOR_PID_FILE).expect("operator PID file");
    let stdout_file = File::create(env::var_os(CLI_STDOUT_FILE).unwrap()).unwrap();
    let stderr_file = File::create(env::var_os(CLI_STDERR_FILE).unwrap()).unwrap();
    let mut operator = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env(SUPERVISOR_PID, std::process::id().to_string())
        .env_remove("RUDDER_MIGRATION_APPLY_DATABASE_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .expect("spawn actual migration operator with a managed parent");
    fs::write(operator_pid_file, operator.id().to_string()).expect("publish operator PID");
    // Keep stdin open: parent-death monitoring must work while the operator is
    // still waiting for its request, before it can connect to PostgreSQL.
    let _open_stdin = operator.stdin.take().expect("operator stdin pipe");
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn abrupt_managed_parent_termination_cancels_operator_and_kills_descendants() {
    let temp = tempfile::tempdir().unwrap();
    let operator_pid_file = temp.path().join("operator.pid");
    let dump_pid_file = temp.path().join("dump.pid");
    let grandchild_pid_file = temp.path().join("grandchild.pid");
    let mut parent = Command::new(env::current_exe().unwrap())
        .args(["--exact", "managed_supervisor_helper", "--nocapture"])
        .env(CHAIN_MODE, "parent")
        .env(OPERATOR_PID_FILE, &operator_pid_file)
        .env(DUMP_PID_FILE, &dump_pid_file)
        .env(GRANDCHILD_PID_FILE, &grandchild_pid_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn managed Node-shaped parent");

    let started = Instant::now();
    while !operator_pid_file.is_file() || !dump_pid_file.is_file() || !grandchild_pid_file.is_file()
    {
        if let Some(status) = parent.try_wait().unwrap() {
            let stderr = parent
                .wait_with_output()
                .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
                .unwrap_or_default();
            panic!("managed parent exited before starting its process chain ({status}): {stderr}");
        }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("managed operator did not publish the full process chain");
        }
        thread::sleep(Duration::from_millis(20));
    }

    let operator_pid = read_pid(&operator_pid_file);
    let dump_pid = read_pid(&dump_pid_file);
    let grandchild_pid = read_pid(&grandchild_pid_file);
    let operator = open_waitable_process(operator_pid);
    let dump = open_waitable_process(dump_pid);
    let grandchild = open_waitable_process(grandchild_pid);

    // TerminateProcess bypasses Node cleanup. The operator must observe the
    // opened parent handle, cancel, and close its kill-on-close job itself.
    parent.kill().expect("terminate managed parent abruptly");
    let parent_status = parent.wait().expect("wait for terminated parent");
    assert!(!parent_status.success(), "parent was externally terminated");

    assert_process_exited(operator, "operator");
    assert_process_exited(dump, "pg_dump-shaped child");
    assert_process_exited(grandchild, "pg_dump grandchild");
}

#[test]
fn actual_cli_handles_parent_death_during_supervisor_startup_race() {
    let temp = tempfile::tempdir().unwrap();
    let operator_pid_file = temp.path().join("operator.pid");
    let stdout_file = temp.path().join("operator.stdout");
    let stderr_file = temp.path().join("operator.stderr");
    let mut parent = Command::new(env::current_exe().unwrap())
        .args(["--exact", "managed_cli_parent_helper", "--nocapture"])
        .env(CHAIN_MODE, "cli-parent")
        .env(OPERATOR_PID_FILE, &operator_pid_file)
        .env(CLI_STDOUT_FILE, &stdout_file)
        .env(CLI_STDERR_FILE, &stderr_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn managed Node-shaped parent");

    let started = Instant::now();
    while !operator_pid_file.is_file() {
        if let Some(status) = parent.try_wait().unwrap() {
            let stderr = parent
                .wait_with_output()
                .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
                .unwrap_or_default();
            panic!("parent exited before starting the actual CLI ({status}): {stderr}");
        }
        if started.elapsed() > Duration::from_secs(15) {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("managed parent did not start the actual CLI");
        }
        thread::sleep(Duration::from_millis(20));
    }
    let operator = open_waitable_process(read_pid(&operator_pid_file));

    parent.kill().expect("terminate managed parent abruptly");
    let parent_status = parent.wait().expect("wait for terminated parent");
    assert!(!parent_status.success(), "parent was externally terminated");
    assert_process_exited(operator, "actual migration CLI");

    let body: serde_json::Value = serde_json::from_slice(&fs::read(stdout_file).unwrap())
        .expect("operator emits structured cancellation output");
    assert!(matches!(
        body["error"]["code"].as_str(),
        Some("supervisor_exited" | "supervisor_monitor_unavailable")
    ));
    assert!(fs::read(stderr_file).unwrap().is_empty());
}

#[test]
fn managed_cli_fails_closed_before_database_lookup_when_supervisor_is_unmonitorable() {
    // The monitor is initialized before the operator reads its request or
    // checks the database URL. A malformed managed-parent identity must stop
    // startup before either dependency can produce a misleading fallback.
    let output = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env(SUPERVISOR_PID, "not-a-pid")
        .env_remove("RUDDER_MIGRATION_APPLY_DATABASE_URL")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("start migration operator");
    let body: serde_json::Value = serde_json::from_slice(&output.stdout)
        .expect("operator emits structured JSON when supervision cannot start");
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(body["error"]["code"], "supervisor_monitor_unavailable");
    assert!(
        output.stderr.is_empty(),
        "operator must not leak diagnostics"
    );
}

fn read_pid(path: &std::path::Path) -> u32 {
    fs::read_to_string(path)
        .unwrap()
        .trim()
        .parse()
        .expect("valid process ID")
}

fn open_waitable_process(pid: u32) -> windows_sys::Win32::Foundation::HANDLE {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
    assert!(
        !handle.is_null(),
        "process {pid} must be alive before parent exit"
    );
    handle
}

fn assert_process_exited(handle: windows_sys::Win32::Foundation::HANDLE, label: &str) {
    let observed = unsafe { WaitForSingleObject(handle, 10_000) };
    if observed != WAIT_OBJECT_0 {
        // Clean up a leaked helper so a failed assertion does not leave a
        // process behind, but retain the original observation for the verdict.
        unsafe {
            TerminateProcess(handle, 1);
            WaitForSingleObject(handle, 10_000);
            CloseHandle(handle);
        }
        assert_eq!(
            observed, WAIT_OBJECT_0,
            "{label} must exit on its own after parent death"
        );
        return;
    }
    unsafe { CloseHandle(handle) };
}
