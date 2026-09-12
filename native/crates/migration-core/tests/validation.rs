use rudder_migration_core::{
    AdvisoryLockRequirement, MIGRATION_ADVISORY_LOCK_NAME, MigrationLimits,
    MigrationManifestOptions, PRE_MUTATION_REQUIREMENTS_VERSION, PreMutationRequirements,
    RecoveryPointRequirement, validate_migration_manifest_compatibility,
    validate_pre_mutation_requirements,
};
use rudder_migration_core::{load_migration_manifest, load_migration_manifest_with_options};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn limits() -> MigrationLimits {
    MigrationLimits {
        max_journal_bytes: 64 * 1024,
        max_sql_file_bytes: 64 * 1024,
        max_total_sql_bytes: 256 * 1024,
        max_sql_files: 32,
        max_directory_entries: 64,
    }
}

fn fixture(entries: &[(&str, &str)], extra_sql: &[(&str, &str)]) -> (TempDir, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    fs::create_dir_all(&meta).unwrap();
    for (tag, sql) in entries.iter().chain(extra_sql.iter()) {
        fs::write(migrations.join(format!("{tag}.sql")), sql).unwrap();
    }
    let journal = json!({
        "version": "7",
        "dialect": "postgresql",
        "entries": entries.iter().enumerate().map(|(idx, (tag, _))| json!({
            "idx": idx,
            "version": "7",
            "when": 1_000 + idx,
            "tag": tag,
            "breakpoints": true,
        })).collect::<Vec<_>>(),
    });
    let journal_path = meta.join("_journal.json");
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    (root, journal_path, migrations)
}

fn load_with_allowlist(
    journal: &Path,
    migrations: &Path,
    allowlist: &[String],
) -> rudder_migration_core::MigrationManifest {
    load_migration_manifest_with_options(
        journal,
        migrations,
        MigrationManifestOptions {
            limits: limits(),
            legacy_unjournaled: allowlist.to_vec(),
        },
    )
    .unwrap()
}

#[test]
fn loads_actual_journal_with_ordered_identity_and_allowlisted_legacy_files() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let journal = root.join("../../../packages/db/src/migrations/meta/_journal.json");
    let migrations = root.join("../../../packages/db/src/migrations");
    let first = load_migration_manifest(&journal, &migrations, MigrationLimits::default()).unwrap();
    let second =
        load_migration_manifest(&journal, &migrations, MigrationLimits::default()).unwrap();

    assert_eq!(first.fingerprint, second.fingerprint);
    assert_eq!(first.journal.entries.len(), 165);
    assert_eq!(first.entries.len(), 167);
    assert_eq!(first.journal.entries[57].tag, "0058_messenger_threads");
    assert_eq!(first.journal.entries[58].tag, "0058_calm_red_ghost");
    assert!(first.entries[165].is_legacy_unjournaled());
    assert_eq!(
        first.entries[165].file_name,
        "0055_illegal_sheva_callister.sql"
    );
    assert_eq!(first.entries[166].file_name, "0128_modern_jetstream.sql");
    assert_eq!(first.entries[0].journal_entry.as_ref().unwrap().idx, 0);
    assert_eq!(
        first.entries[0].journal_entry.as_ref().unwrap().tag,
        first.journal.entries[0].tag
    );
    assert_eq!(first.fingerprint.len(), 64);
}

#[test]
fn loads_fixture_and_preserves_deterministic_sha256_manifest() {
    let (_root, journal, migrations) = fixture(
        &[
            ("0000_first", "CREATE TABLE first_table (id integer);"),
            ("0001_second", "SELECT 1;"),
        ],
        &[("legacy", "SELECT 2;")],
    );
    let manifest = load_with_allowlist(&journal, &migrations, &["legacy.sql".to_owned()]);

    assert_eq!(manifest.entries.len(), 3);
    assert_eq!(manifest.entries[0].order, 0);
    assert_eq!(manifest.entries[1].file_name, "0001_second.sql");
    assert_eq!(manifest.entries[2].order, 2);
    assert!(manifest.entries[2].is_legacy_unjournaled());
    assert_eq!(manifest.entries[2].sha256.len(), 64);
    assert_eq!(manifest.sql_files.len(), 3);
    assert!(manifest.validate_integrity().valid);
}

#[test]
fn rejects_unbounded_reads_and_unknown_sql_files() {
    let (_root, journal, migrations) = fixture(&[("0000_first", "SELECT 1;")], &[]);
    let mut bounded = limits();
    bounded.max_journal_bytes = 8;
    let error = load_migration_manifest_with_options(
        &journal,
        &migrations,
        MigrationManifestOptions {
            limits: bounded,
            legacy_unjournaled: Vec::new(),
        },
    )
    .unwrap_err();
    assert_eq!(error.code(), "migration_journal_size_limit");

    let (_root, journal, migrations) = fixture(
        &[("0000_first", "SELECT 1;")],
        &[("0001_unknown", "SELECT 2;")],
    );
    let error = load_migration_manifest_with_options(
        &journal,
        &migrations,
        MigrationManifestOptions {
            limits: limits(),
            legacy_unjournaled: Vec::new(),
        },
    )
    .unwrap_err();
    assert_eq!(error.code(), "migration_sql_unknown");
}

#[test]
fn rejects_missing_reordered_and_duplicate_journal_entries() {
    let (_root, journal, migrations) = fixture(&[("0000_missing", "SELECT 1;")], &[]);
    fs::remove_file(migrations.join("0000_missing.sql")).unwrap();
    let error = load_migration_manifest(&journal, &migrations, limits()).unwrap_err();
    assert_eq!(error.code(), "migration_sql_missing");

    let (_root, journal, migrations) = fixture(
        &[("0000_first", "SELECT 1;"), ("0001_second", "SELECT 2;")],
        &[],
    );
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    value["entries"][0]["idx"] = json!(1);
    fs::write(&journal, serde_json::to_vec(&value).unwrap()).unwrap();
    let error = load_migration_manifest(&journal, &migrations, limits()).unwrap_err();
    assert_eq!(error.code(), "migration_journal_reordered");

    let (_root, journal, migrations) = fixture(
        &[("0000_first", "SELECT 1;"), ("0001_second", "SELECT 2;")],
        &[],
    );
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    value["entries"][1]["tag"] = json!("0000_first");
    fs::write(&journal, serde_json::to_vec(&value).unwrap()).unwrap();
    let error = load_migration_manifest(&journal, &migrations, limits()).unwrap_err();
    assert_eq!(error.code(), "migration_journal_duplicate");
}

#[test]
fn rejects_edited_published_prefix_but_allows_append_only_candidate() {
    let (_base_root, base_journal, base_migrations) = fixture(
        &[("0000_first", "SELECT 1;"), ("0001_second", "SELECT 2;")],
        &[],
    );
    let baseline = load_migration_manifest(&base_journal, &base_migrations, limits()).unwrap();

    let (_append_root, append_journal, append_migrations) = fixture(
        &[
            ("0000_first", "SELECT 1;"),
            ("0001_second", "SELECT 2;"),
            ("0002_third", "SELECT 3;"),
        ],
        &[],
    );
    let appended = load_migration_manifest(&append_journal, &append_migrations, limits()).unwrap();
    let compatibility = validate_migration_manifest_compatibility(&baseline, &appended);
    assert!(compatibility.valid);
    assert!(compatibility.compatible);
    assert_eq!(compatibility.added_entries.len(), 1);

    let (_edited_root, edited_journal, edited_migrations) = fixture(
        &[("0000_first", "SELECT 9;"), ("0001_second", "SELECT 2;")],
        &[],
    );
    let edited = load_migration_manifest(&edited_journal, &edited_migrations, limits()).unwrap();
    let compatibility = validate_migration_manifest_compatibility(&baseline, &edited);
    assert!(!compatibility.valid);
    assert!(!compatibility.compatible);
    assert!(
        compatibility
            .errors
            .iter()
            .any(|error| error.contains("0000_first.sql"))
    );
}

fn valid_pre_mutation_requirements() -> PreMutationRequirements {
    PreMutationRequirements {
        version: PRE_MUTATION_REQUIREMENTS_VERSION,
        database_non_empty: true,
        mutation_requested: true,
        lock: AdvisoryLockRequirement {
            name: MIGRATION_ADVISORY_LOCK_NAME.to_owned(),
            acquired: true,
        },
        recovery: RecoveryPointRequirement {
            required: true,
            created: true,
            includes_migration_journal: true,
            path: Some("/var/lib/rudder/pre-migration.sql".to_owned()),
        },
    }
}

#[test]
fn validates_versioned_pre_mutation_recovery_and_lock_requirements_without_db_access() {
    let valid = valid_pre_mutation_requirements();
    let result = validate_pre_mutation_requirements(&valid);
    assert!(result.valid);
    assert!(result.errors.is_empty());
    assert!(!result.database_mutated);

    let mut missing_lock = valid.clone();
    missing_lock.lock.acquired = false;
    let result = validate_pre_mutation_requirements(&missing_lock);
    assert!(!result.valid);
    assert!(
        result
            .errors
            .iter()
            .any(|error| error.contains("advisory lock"))
    );

    let mut missing_recovery = valid;
    missing_recovery.recovery.created = false;
    let result = validate_pre_mutation_requirements(&missing_recovery);
    assert!(!result.valid);
    assert!(result.errors.iter().any(|error| error.contains("recovery")));

    let empty_database = PreMutationRequirements {
        database_non_empty: false,
        mutation_requested: true,
        recovery: RecoveryPointRequirement {
            required: false,
            created: false,
            includes_migration_journal: false,
            path: None,
        },
        ..valid_pre_mutation_requirements()
    };
    assert!(validate_pre_mutation_requirements(&empty_database).valid);
}
