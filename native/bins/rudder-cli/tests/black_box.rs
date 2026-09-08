use serde_json::Value;
use std::fs;
use std::process::Command;
use tempfile::tempdir;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_rudder-cli")
}

#[test]
fn reports_version_without_starting_a_runtime() {
    let output = Command::new(binary()).arg("--version").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("rudder-cli {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn lists_only_bounded_workspace_directory_entries() {
    let root = tempdir().unwrap();
    fs::create_dir(root.path().join("projects")).unwrap();
    fs::create_dir(root.path().join("projects/zeta")).unwrap();
    fs::write(root.path().join("projects/alpha.md"), b"alpha").unwrap();

    let output = Command::new(binary())
        .args([
            "workspace",
            "list",
            root.path().to_str().unwrap(),
            "projects",
            "100",
            "4096",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(response["capability"], "workspace.list");
    assert_eq!(response["operation"], "listWorkspaceDirectory");
    assert_eq!(response["protocolVersion"], 1);
    assert_eq!(response["accepted"], false);
    assert_eq!(response["directoryPath"], "projects");
    assert_eq!(
        response["entries"],
        serde_json::json!([
            { "name": "alpha.md", "path": "projects/alpha.md", "isDirectory": false },
            { "name": "zeta", "path": "projects/zeta", "isDirectory": true }
        ])
    );
}

#[test]
fn rejects_workspace_escape_without_writing_anything() {
    let root = tempdir().unwrap();
    fs::create_dir(root.path().join("projects")).unwrap();
    let output = Command::new(binary())
        .args([
            "workspace",
            "list",
            root.path().to_str().unwrap(),
            "../outside",
            "100",
            "4096",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], false);
    assert_eq!(response["capability"], "workspace.list");
    assert_eq!(response["accepted"], false);
    assert_eq!(response["errorCode"], "rudder_mcp_workspace_error");
}
