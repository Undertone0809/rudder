use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
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

fn migration_fixture(root: &Path, entries: &[(&str, &str)]) -> (PathBuf, PathBuf) {
    let migrations = root.join("migrations");
    let meta = migrations.join("meta");
    fs::create_dir_all(&meta).unwrap();
    for (tag, sql) in entries {
        fs::write(migrations.join(format!("{tag}.sql")), sql).unwrap();
    }
    let journal = serde_json::json!({
        "version": "7",
        "dialect": "postgresql",
        "entries": entries.iter().enumerate().map(|(idx, (tag, _))| serde_json::json!({
            "idx": idx,
            "version": "7",
            "when": 1_000 + idx,
            "tag": tag,
            "breakpoints": true,
        })).collect::<Vec<_>>(),
    });
    let journal_path = meta.join("_journal.json");
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    (journal_path, migrations)
}

#[test]
fn inspects_explicit_candidate_and_baseline_without_database_access() {
    let baseline_root = tempdir().unwrap();
    let (baseline_journal, baseline_migrations) =
        migration_fixture(baseline_root.path(), &[("0000_first", "SELECT 1;")]);
    let candidate_root = tempdir().unwrap();
    let (candidate_journal, candidate_migrations) = migration_fixture(
        candidate_root.path(),
        &[("0000_first", "SELECT 1;"), ("0001_second", "SELECT 2;")],
    );
    let before = fs::read(candidate_journal.clone()).unwrap();

    let output = Command::new(binary())
        .args([
            "migration",
            "inspect",
            "--journal",
            candidate_journal.to_str().unwrap(),
            "--migrations-dir",
            candidate_migrations.to_str().unwrap(),
            "--baseline-journal",
            baseline_journal.to_str().unwrap(),
            "--baseline-migrations-dir",
            baseline_migrations.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(response["capability"], "migration.inspect");
    assert_eq!(response["operation"], "inspectMigrationManifest");
    assert_eq!(response["protocolVersion"], 1);
    assert_eq!(response["accepted"], false);
    assert_eq!(response["validation"]["outcome"], "valid");
    assert_eq!(response["validation"]["manifestValid"], true);
    assert_eq!(response["validation"]["compatible"], true);
    assert_eq!(response["validation"]["errors"], serde_json::json!([]));
    assert_eq!(response["counts"]["journalEntries"], 2);
    assert_eq!(response["counts"]["manifestEntries"], 2);
    assert_eq!(response["counts"]["sqlFiles"], 2);
    assert_eq!(response["counts"]["legacyUnjournaled"], 0);
    assert_eq!(response["counts"]["baselineJournalEntries"], 1);
    assert_eq!(response["counts"]["baselineEntries"], 1);
    assert_eq!(response["counts"]["addedEntries"], 1);
    assert_eq!(
        response["addedEntries"],
        serde_json::json!(["0001_second.sql"])
    );
    assert_eq!(response["candidateFingerprint"].as_str().unwrap().len(), 64);
    assert_eq!(response["baselineFingerprint"].as_str().unwrap().len(), 64);
    assert_eq!(fs::read(candidate_journal).unwrap(), before);
}

#[test]
fn migration_inspect_requires_explicit_paths_and_rejects_unknown_options() {
    let root = tempdir().unwrap();
    let (journal, migrations) = migration_fixture(root.path(), &[("0000_first", "SELECT 1;")]);

    let missing = Command::new(binary())
        .args([
            "migration",
            "inspect",
            "--journal",
            journal.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(2));
    let missing_response: Value = serde_json::from_slice(&missing.stdout).unwrap();
    assert_eq!(missing_response["errorCode"], "usage");

    let unknown = Command::new(binary())
        .args([
            "migration",
            "inspect",
            "--journal",
            journal.to_str().unwrap(),
            "--migrations-dir",
            migrations.to_str().unwrap(),
            "--database-url",
            "postgres://user:password@example.invalid/db",
        ])
        .output()
        .unwrap();
    assert_eq!(unknown.status.code(), Some(2));
    let unknown_response: Value = serde_json::from_slice(&unknown.stdout).unwrap();
    assert_eq!(unknown_response["errorCode"], "unknown_option");
    assert_eq!(unknown_response["validationOutcome"], "invalid");
}

#[test]
fn migration_inspect_fails_closed_on_fingerprint_and_compatibility_mismatch() {
    let baseline_root = tempdir().unwrap();
    let (baseline_journal, baseline_migrations) =
        migration_fixture(baseline_root.path(), &[("0000_first", "SELECT 1;")]);
    let candidate_root = tempdir().unwrap();
    let (candidate_journal, candidate_migrations) =
        migration_fixture(candidate_root.path(), &[("0000_first", "SELECT changed;")]);

    let fingerprint = Command::new(binary())
        .args([
            "migration",
            "inspect",
            "--journal",
            candidate_journal.to_str().unwrap(),
            "--migrations-dir",
            candidate_migrations.to_str().unwrap(),
            "--expected-fingerprint",
            &"b".repeat(64),
        ])
        .output()
        .unwrap();
    assert_eq!(fingerprint.status.code(), Some(2));
    let fingerprint_response: Value = serde_json::from_slice(&fingerprint.stdout).unwrap();
    assert_eq!(
        fingerprint_response["errorCode"],
        "migration_fingerprint_mismatch"
    );
    assert_eq!(fingerprint_response["validationOutcome"], "invalid");

    let incompatible = Command::new(binary())
        .args([
            "migration",
            "inspect",
            "--journal",
            candidate_journal.to_str().unwrap(),
            "--migrations-dir",
            candidate_migrations.to_str().unwrap(),
            "--baseline-journal",
            baseline_journal.to_str().unwrap(),
            "--baseline-migrations-dir",
            baseline_migrations.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(incompatible.status.code(), Some(2));
    let incompatible_response: Value = serde_json::from_slice(&incompatible.stdout).unwrap();
    assert_eq!(incompatible_response["ok"], false);
    assert_eq!(
        incompatible_response["errorCode"],
        "migration_manifest_incompatible"
    );
    assert_eq!(incompatible_response["validation"]["manifestValid"], true);
    assert_eq!(incompatible_response["validation"]["compatible"], false);
    assert_eq!(
        incompatible_response["validation"]["outcome"],
        "incompatible"
    );
}

#[test]
fn migration_inspect_fails_closed_on_missing_and_oversized_files() {
    let missing_root = tempdir().unwrap();
    let (missing_journal, missing_migrations) =
        migration_fixture(missing_root.path(), &[("0000_first", "SELECT 1;")]);
    fs::remove_file(missing_migrations.join("0000_first.sql")).unwrap();
    let missing = Command::new(binary())
        .args([
            "migration",
            "inspect",
            "--journal",
            missing_journal.to_str().unwrap(),
            "--migrations-dir",
            missing_migrations.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(2));
    let missing_response: Value = serde_json::from_slice(&missing.stdout).unwrap();
    assert_eq!(missing_response["errorCode"], "migration_sql_missing");
    assert_eq!(missing_response["validationOutcome"], "invalid");

    let oversized_root = tempdir().unwrap();
    let (oversized_journal, oversized_migrations) =
        migration_fixture(oversized_root.path(), &[("0000_first", "SELECT 1;")]);
    fs::write(
        oversized_migrations.join("0000_first.sql"),
        vec![b'x'; 4 * 1024 * 1024 + 1],
    )
    .unwrap();
    let oversized = Command::new(binary())
        .args([
            "migration",
            "inspect",
            "--journal",
            oversized_journal.to_str().unwrap(),
            "--migrations-dir",
            oversized_migrations.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(oversized.status.code(), Some(2));
    let oversized_response: Value = serde_json::from_slice(&oversized.stdout).unwrap();
    assert_eq!(oversized_response["errorCode"], "migration_sql_size_limit");
    assert_eq!(oversized_response["validationOutcome"], "invalid");
}
