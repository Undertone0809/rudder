use rudder_migration_core::{
    MigrationLimits, MigrationManifest, load_migration_manifest,
    validate_migration_manifest_compatibility,
};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const LEGACY: [&str; 2] = [
    "0055_illegal_sheva_callister.sql",
    "0128_modern_jetstream.sql",
];

fn fixture() -> TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("meta")).unwrap();
    write_journal(
        root.path(),
        &json!({
            "version": "7", "dialect": "postgresql",
            "entries": [{
                "idx": 0, "version": "7", "when": 1000,
                "tag": "0000_first", "breakpoints": true,
            }],
        }),
    );
    fs::write(root.path().join("0000_first.sql"), "SELECT 1;\n").unwrap();
    for name in LEGACY {
        fs::write(root.path().join(name), "SELECT 2;\n").unwrap();
    }
    root
}

fn journal(root: &Path) -> Value {
    serde_json::from_slice(&fs::read(root.join("meta/_journal.json")).unwrap()).unwrap()
}

fn write_journal(root: &Path, value: &Value) {
    fs::write(
        root.join("meta/_journal.json"),
        serde_json::to_vec(value).unwrap(),
    )
    .unwrap();
}

fn load(root: &Path) -> MigrationManifest {
    load_migration_manifest(
        &root.join("meta/_journal.json"),
        root,
        MigrationLimits::default(),
    )
    .unwrap()
}

fn append(root: &Path) -> String {
    let mut value = journal(root);
    let entries = value["entries"].as_array_mut().unwrap();
    let idx = entries.len();
    let when = entries.last().unwrap()["when"].as_u64().unwrap() + 1;
    let tag = format!("{idx:04}_append_probe");
    entries.push(json!({
        "idx": idx, "version": "7", "when": when,
        "tag": tag, "breakpoints": true,
    }));
    write_journal(root, &value);
    let name = format!("{tag}.sql");
    fs::write(root.join(&name), "SELECT 3;\n").unwrap();
    name
}

#[test]
fn appends_with_legacy_files_report_only_new_journaled_sql() {
    let root = fixture();
    let baseline = load(root.path());
    let first = append(root.path());
    let second = append(root.path());
    let candidate = load(root.path());
    let result = validate_migration_manifest_compatibility(&baseline, &candidate);
    assert!(result.valid, "{:?}", result.errors);
    assert_eq!(result.added_entries, vec![first, second]);
    assert!(
        validate_migration_manifest_compatibility(&baseline, &baseline)
            .added_entries
            .is_empty()
    );
}

#[test]
fn rejects_edited_or_removed_legacy_sql_despite_a_new_journal_entry() {
    for name in LEGACY {
        for remove in [false, true] {
            let root = fixture();
            let baseline = load(root.path());
            append(root.path());
            if remove {
                fs::remove_file(root.path().join(name)).unwrap();
            } else {
                fs::write(root.path().join(name), "SELECT 999;\n").unwrap();
            }
            let result = validate_migration_manifest_compatibility(&baseline, &load(root.path()));
            assert!(!result.valid);
            assert!(result.errors.iter().any(|error| error.contains(name)));
        }
    }
}

#[test]
fn journal_metadata_changes_are_not_hidden_by_identical_sql_hashes() {
    for (field, changed) in [
        ("when", json!(999)),
        ("version", json!("8")),
        ("breakpoints", json!(false)),
    ] {
        let root = fixture();
        let baseline = load(root.path());
        let mut value = journal(root.path());
        value["entries"][0][field] = changed;
        write_journal(root.path(), &value);
        let result = validate_migration_manifest_compatibility(&baseline, &load(root.path()));
        assert!(!result.valid, "{field}");
        assert!(result.errors.iter().any(|error| error.contains("journal")));
    }
}

#[test]
fn rejects_legacy_promotion_and_new_unjournaled_assets() {
    let root = fixture();
    let baseline = load(root.path());
    let mut value = journal(root.path());
    value["entries"].as_array_mut().unwrap().push(json!({
        "idx": 1, "version": "7", "when": 1001,
        "tag": LEGACY[0].trim_end_matches(".sql"), "breakpoints": true,
    }));
    write_journal(root.path(), &value);
    assert!(!validate_migration_manifest_compatibility(&baseline, &load(root.path())).valid);

    let root = fixture();
    fs::remove_file(root.path().join(LEGACY[0])).unwrap();
    let baseline = load(root.path());
    fs::write(root.path().join(LEGACY[0]), "SELECT 2;\n").unwrap();
    let result = validate_migration_manifest_compatibility(&baseline, &load(root.path()));
    assert!(!result.valid);
    assert!(result.added_entries.is_empty());
}

#[test]
fn rejects_forged_fingerprints_and_inconsistent_manifest_views() {
    let root = fixture();
    let baseline = load(root.path());
    let mut forged = baseline.clone();
    forged.fingerprint = "0".repeat(64);
    assert!(!forged.validate_integrity().valid);
    assert!(!validate_migration_manifest_compatibility(&baseline, &forged).valid);
    let mut inconsistent = baseline.clone();
    inconsistent.journal.entries[0].breakpoints = false;
    assert!(!inconsistent.validate_integrity().valid);
    assert!(!validate_migration_manifest_compatibility(&baseline, &inconsistent).valid);
}

#[test]
fn actual_repository_journal_allows_a_disposable_append_without_source_changes() {
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/db/src/migrations");
    let baseline = load(&source);
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("meta")).unwrap();
    fs::copy(
        source.join("meta/_journal.json"),
        root.path().join("meta/_journal.json"),
    )
    .unwrap();
    for entry in &baseline.entries {
        fs::copy(
            source.join(&entry.file_name),
            root.path().join(&entry.file_name),
        )
        .unwrap();
    }
    let added = append(root.path());
    let result = validate_migration_manifest_compatibility(&baseline, &load(root.path()));
    assert!(result.valid, "{:?}", result.errors);
    assert_eq!(result.added_entries, vec![added]);
    assert_eq!(baseline, load(&source));
}
