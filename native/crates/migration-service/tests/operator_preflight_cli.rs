//! The explicit operator must validate its complete pinned source before it
//! asks the process environment for database credentials.
use rudder_migration_core::{MigrationLimits, load_migration_manifest};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, ExitStatus, Stdio},
};

fn request(root: &Path) -> Value {
    json!({
        "schema": "rudder.migration-apply/v1",
        "protocolVersion": 1,
        "allowApply": true,
        "migrationsDir": root.join("migrations"),
        "expectedFingerprint": "a".repeat(64),
        "recoveryDirectory": root.join("recovery"),
        "pgDumpBinary": root.join("pg_dump"),
    })
}

fn write_valid_source(root: &Path) -> String {
    let migrations = root.join("migrations");
    fs::create_dir_all(migrations.join("meta")).unwrap();
    fs::write(migrations.join("0000_test.sql"), "SELECT 1;\n").unwrap();
    fs::write(
        migrations.join("meta/_journal.json"),
        json!({
            "version": "7",
            "dialect": "postgresql",
            "entries": [{
                "idx": 0,
                "version": "7",
                "when": 1000,
                "tag": "0000_test",
                "breakpoints": true,
            }],
        })
        .to_string(),
    )
    .unwrap();
    load_migration_manifest(
        &migrations.join("meta/_journal.json"),
        &migrations,
        MigrationLimits::default(),
    )
    .unwrap()
    .fingerprint
}

fn invoke(input: &[u8]) -> (ExitStatus, Value, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_migration-apply"))
        .env_remove("RUDDER_MIGRATION_APPLY_DATABASE_URL")
        .env_remove("DATABASE_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn migration-apply CLI");
    child
        .stdin
        .take()
        .expect("operator stdin")
        .write_all(input)
        .expect("write operator request");
    let output = child.wait_with_output().expect("wait for operator CLI");
    let body = serde_json::from_slice(&output.stdout).expect("operator emits JSON");
    let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
    (output.status, body, stderr)
}

fn assert_preflight_error(status: ExitStatus, body: &Value, stderr: &str, code: &str) {
    assert_eq!(status.code(), Some(2));
    assert_eq!(body["schema"], "rudder.migration-apply/v1");
    assert_eq!(body["status"], "error");
    assert_eq!(body["error"]["code"], code);
    assert!(
        stderr.is_empty(),
        "operator must keep diagnostics off stderr"
    );
}

#[test]
fn malformed_json_is_reported_before_missing_database_url() {
    let (status, body, stderr) = invoke(b"{not-json");
    assert_preflight_error(status, &body, &stderr, "invalid_request");
}

#[test]
fn wrong_schema_is_reported_before_missing_database_url_or_source_access() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request(root.path());
    request["schema"] = json!("rudder.migration-apply/v2");
    let (status, body, stderr) = invoke(request.to_string().as_bytes());
    assert_preflight_error(status, &body, &stderr, "explicit_apply_contract_required");
}

#[test]
fn apply_opt_in_is_required_before_missing_database_url_or_source_access() {
    let root = tempfile::tempdir().unwrap();
    let mut request = request(root.path());
    request["allowApply"] = json!(false);
    let (status, body, stderr) = invoke(request.to_string().as_bytes());
    assert_preflight_error(status, &body, &stderr, "explicit_apply_contract_required");
}

#[test]
fn invalid_pinned_migration_source_is_reported_before_missing_database_url() {
    let root = tempfile::tempdir().unwrap();
    let request = request(root.path());
    let (status, body, stderr) = invoke(request.to_string().as_bytes());
    assert_preflight_error(status, &body, &stderr, "migration_source_invalid");
}

#[test]
fn fingerprint_mismatch_is_reported_before_missing_database_url() {
    let root = tempfile::tempdir().unwrap();
    write_valid_source(root.path());
    let request = request(root.path());
    let (status, body, stderr) = invoke(request.to_string().as_bytes());
    assert_preflight_error(status, &body, &stderr, "migration_source_invalid");
}

#[test]
fn valid_source_reaches_database_url_requirement_after_preflight() {
    let root = tempfile::tempdir().unwrap();
    let fingerprint = write_valid_source(root.path());
    let mut request = request(root.path());
    request["expectedFingerprint"] = json!(fingerprint);
    let (status, body, stderr) = invoke(request.to_string().as_bytes());
    assert_preflight_error(status, &body, &stderr, "database_url_missing");
}

#[test]
fn validation_only_request_is_accepted_before_database_url_lookup() {
    let root = tempfile::tempdir().unwrap();
    let fingerprint = write_valid_source(root.path());
    let mut request = request(root.path());
    request["expectedFingerprint"] = json!(fingerprint);
    request["validateOnly"] = json!(true);
    let (status, body, stderr) = invoke(request.to_string().as_bytes());
    assert_preflight_error(status, &body, &stderr, "database_url_missing");
}
