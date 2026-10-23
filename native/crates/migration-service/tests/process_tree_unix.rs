#![cfg(unix)]

//! Managed Unix child-process coverage. SIGKILL of the parent bypasses Node's
//! AbortController, so the operator must notice kernel reparenting itself.

use std::{
    env,
    fs::{self, File},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const HELPER_MODE: &str = "RUDDER_MIGRATION_UNIX_SUPERVISOR_HELPER";
const SUPERVISOR_PID: &str = "RUDDER_MIGRATION_APPLY_SUPERVISOR_PID";
const OPERATOR_PID_FILE: &str = "RUDDER_MIGRATION_UNIX_OPERATOR_PID_FILE";
const CLI_STDOUT_FILE: &str = "RUDDER_MIGRATION_UNIX_CLI_STDOUT_FILE";
const CLI_STDERR_FILE: &str = "RUDDER_MIGRATION_UNIX_CLI_STDERR_FILE";

#[test]
fn managed_cli_parent_helper() {
    if env::var(HELPER_MODE).as_deref() != Ok("stdin") {
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
        .expect("spawn actual migration CLI");
    // This PID file identifies the child for termination checks; it is not a
    // readiness signal. The parent may die before or after the CLI validates
    // the supervisor identity, and both startup outcomes are fail-closed.
    fs::write(operator_pid_file, operator.id().to_string()).expect("publish operator PID");

    // Leave stdin open indefinitely. The parent's death must wake the
    // supervisor monitor even though the operator has no request to parse.
    let _open_stdin = operator.stdin.take().expect("operator stdin pipe");
    let _operator_waiter = thread::spawn(move || {
        operator.wait().expect("reap operator after it exits");
    });
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn actual_cli_handles_parent_death_during_supervisor_startup_race() {
    let temp = tempfile::tempdir().unwrap();
    let operator_pid_file = temp.path().join("operator.pid");
    let stdout_file = temp.path().join("operator.stdout");
    let stderr_file = temp.path().join("operator.stderr");
    let mut parent = Command::new(env::current_exe().unwrap())
        .args(["--exact", "managed_cli_parent_helper", "--nocapture"])
        .env(HELPER_MODE, "stdin")
        .env(OPERATOR_PID_FILE, &operator_pid_file)
        .env(CLI_STDOUT_FILE, &stdout_file)
        .env(CLI_STDERR_FILE, &stderr_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Node-shaped parent");

    let operator_pid = wait_for_pid_file(&operator_pid_file, &mut parent);
    let operator_pid_text = operator_pid.to_string();

    parent.kill().expect("SIGKILL managed parent");
    let status = parent.wait().expect("wait for killed parent");
    assert!(!status.success(), "parent must be terminated with SIGKILL");

    let body = wait_for_json_receipt(&stdout_file, &operator_pid_text);
    assert!(matches!(
        body["error"]["code"].as_str(),
        Some("supervisor_exited" | "supervisor_monitor_unavailable")
    ));
    assert!(fs::read(stderr_file).unwrap().is_empty());
    wait_for_process_stopped(operator_pid, "actual migration CLI");
}

#[test]
fn managed_cli_rejects_a_parent_pid_that_is_not_its_actual_parent() {
    let output = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env(SUPERVISOR_PID, "1")
        .env_remove("RUDDER_MIGRATION_APPLY_DATABASE_URL")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("start migration CLI with an invalid supervisor identity");
    let body: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(body["error"]["code"], "supervisor_monitor_unavailable");
    assert!(output.stderr.is_empty());
}

#[test]
fn standalone_cli_without_supervisor_keeps_its_explicit_input_contract() {
    let output = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env_remove(SUPERVISOR_PID)
        .env_remove("RUDDER_MIGRATION_APPLY_DATABASE_URL")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("start standalone migration CLI");
    let body: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(body["error"]["code"], "invalid_request");
    assert!(output.stderr.is_empty());
}

fn wait_for_pid_file(path: &std::path::Path, parent: &mut std::process::Child) -> u32 {
    let started = Instant::now();
    loop {
        if path.is_file() {
            return fs::read_to_string(path)
                .unwrap()
                .trim()
                .parse()
                .expect("valid operator PID");
        }
        if let Some(status) = parent.try_wait().unwrap() {
            let _ = parent.wait();
            panic!("parent exited before starting operator ({status})");
        }
        if started.elapsed() > Duration::from_secs(15) {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("managed parent did not start the operator");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_json_receipt(path: &std::path::Path, pid: &str) -> serde_json::Value {
    let started = Instant::now();
    loop {
        if let Ok(bytes) = fs::read(path)
            && let Ok(body) = serde_json::from_slice(&bytes)
        {
            return body;
        }
        if started.elapsed() > Duration::from_secs(15) {
            terminate_pid(pid);
            panic!("operator did not write its cancellation receipt");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_process_stopped(pid: u32, label: &str) {
    let started = Instant::now();
    loop {
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .expect("Unix ps command is available");
        let state = String::from_utf8_lossy(&state.stdout).trim().to_owned();
        if state.is_empty() || state.starts_with('Z') {
            return;
        }
        if started.elapsed() > Duration::from_secs(10) {
            terminate_pid(&pid.to_string());
            panic!("{label} remained alive after managed parent death (state {state})");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn terminate_pid(pid: &str) {
    let _ = Command::new("kill").args(["-KILL", pid]).status();
}
