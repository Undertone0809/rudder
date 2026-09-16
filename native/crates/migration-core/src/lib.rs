//! Bounded, read-only validation for Rudder's PostgreSQL migration assets.
//!
//! The validator is intentionally separate from database execution. An SQLx
//! runner can call it before taking the advisory lock or changing any row, then
//! use the resulting immutable fingerprint and ordered entries as its authority
//! input.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const PRE_MUTATION_REQUIREMENTS_VERSION: u16 = 1;
pub const MIGRATION_ADVISORY_LOCK_NAME: &str = "rudder.migrations.v1";
const DEFAULT_LEGACY_UNJOURNALED: [&str; 2] = [
    "0055_illegal_sheva_callister.sql",
    "0128_modern_jetstream.sql",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MigrationLimits {
    pub max_journal_bytes: u64,
    pub max_sql_file_bytes: u64,
    pub max_total_sql_bytes: u64,
    pub max_sql_files: usize,
    pub max_directory_entries: usize,
}

impl Default for MigrationLimits {
    fn default() -> Self {
        Self {
            max_journal_bytes: 4 * 1024 * 1024,
            max_sql_file_bytes: 4 * 1024 * 1024,
            max_total_sql_bytes: 512 * 1024 * 1024,
            max_sql_files: 512,
            max_directory_entries: 1_024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationManifestOptions {
    pub limits: MigrationLimits,
    pub legacy_unjournaled: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationJournal {
    pub version: String,
    pub dialect: String,
    pub entries: Vec<JournalEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JournalEntry {
    pub idx: usize,
    pub version: String,
    pub when: u64,
    pub tag: String,
    pub breakpoints: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct MigrationEntry {
    pub order: usize,
    pub file_name: String,
    pub sha256: String,
    pub byte_size: u64,
    pub journal_entry: Option<JournalEntry>,
}

impl MigrationEntry {
    pub fn is_legacy_unjournaled(&self) -> bool {
        self.journal_entry.is_none()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct MigrationManifest {
    pub journal: MigrationJournal,
    pub entries: Vec<MigrationEntry>,
    pub sql_files: Vec<String>,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntegrityResult {
    pub valid: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Error)]
#[error("{code}: {message}")]
pub struct MigrationError {
    code: &'static str,
    message: String,
}

impl MigrationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationCompatibility {
    pub valid: bool,
    pub compatible: bool,
    pub added_entries: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PreMutationValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    pub database_mutated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdvisoryLockRequirement {
    pub name: String,
    pub acquired: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecoveryPointRequirement {
    pub required: bool,
    pub created: bool,
    pub includes_migration_journal: bool,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PreMutationRequirements {
    pub version: u16,
    pub database_non_empty: bool,
    pub mutation_requested: bool,
    pub lock: AdvisoryLockRequirement,
    pub recovery: RecoveryPointRequirement,
}

impl MigrationManifest {
    pub fn validate_integrity(&self) -> IntegrityResult {
        let mut errors = Vec::new();
        let mut seen = BTreeSet::new();
        for (expected_order, entry) in self.entries.iter().enumerate() {
            if entry.order != expected_order {
                errors.push(format!("entry order mismatch for {}", entry.file_name));
            }
            if !seen.insert(entry.file_name.clone()) {
                errors.push(format!("duplicate migration file {}", entry.file_name));
            }
            if entry.sha256.len() != 64
                || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                errors.push(format!("invalid SHA-256 for {}", entry.file_name));
            }
        }
        if self.sql_files
            != self
                .entries
                .iter()
                .map(|entry| entry.file_name.clone())
                .collect::<Vec<_>>()
        {
            errors.push("sql file list does not match ordered entries".to_owned());
        }
        IntegrityResult {
            valid: errors.is_empty(),
            errors,
        }
    }
}

pub fn load_migration_manifest(
    journal_path: &Path,
    migrations_dir: &Path,
    limits: MigrationLimits,
) -> Result<MigrationManifest, MigrationError> {
    load_migration_manifest_with_options(
        journal_path,
        migrations_dir,
        MigrationManifestOptions {
            limits,
            legacy_unjournaled: DEFAULT_LEGACY_UNJOURNALED
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        },
    )
}

pub fn load_migration_manifest_with_options(
    journal_path: &Path,
    migrations_dir: &Path,
    options: MigrationManifestOptions,
) -> Result<MigrationManifest, MigrationError> {
    let journal_bytes = read_bounded_file(
        journal_path,
        options.limits.max_journal_bytes,
        "migration_journal_size_limit",
    )?;
    let journal: MigrationJournal = serde_json::from_slice(&journal_bytes)
        .map_err(|error| MigrationError::new("migration_journal_invalid", error.to_string()))?;
    if journal.version != "7" || journal.dialect != "postgresql" {
        return Err(MigrationError::new(
            "migration_journal_invalid",
            "journal version or dialect is unsupported",
        ));
    }

    let mut journal_names = BTreeSet::new();
    for (expected_idx, entry) in journal.entries.iter().enumerate() {
        if entry.idx != expected_idx {
            return Err(MigrationError::new(
                "migration_journal_reordered",
                format!(
                    "journal entry {} has index {}, expected {}",
                    entry.tag, entry.idx, expected_idx
                ),
            ));
        }
        if entry.tag.trim().is_empty()
            || entry.tag.contains('/')
            || entry.tag.contains('\\')
            || entry.tag.contains('\0')
        {
            return Err(MigrationError::new(
                "migration_journal_invalid",
                "journal tag is unsafe",
            ));
        }
        let file_name = format!("{}.sql", entry.tag);
        if !journal_names.insert(file_name.clone()) {
            return Err(MigrationError::new(
                "migration_journal_duplicate",
                format!("journal contains duplicate {}", file_name),
            ));
        }
    }

    let mut directory_files = BTreeMap::<String, PathBuf>::new();
    let directory = fs::read_dir(migrations_dir).map_err(|error| {
        MigrationError::new("migration_directory_unreadable", error.to_string())
    })?;
    for item in directory.take(options.limits.max_directory_entries.saturating_add(1)) {
        let item = item.map_err(|error| {
            MigrationError::new("migration_directory_unreadable", error.to_string())
        })?;
        let file_type = item.file_type().map_err(|error| {
            MigrationError::new("migration_directory_unreadable", error.to_string())
        })?;
        if !file_type.is_file() {
            continue;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        if name.ends_with(".sql") {
            if directory_files.len() >= options.limits.max_directory_entries {
                return Err(MigrationError::new(
                    "migration_directory_entries_limit",
                    "migration directory is too large",
                ));
            }
            directory_files.insert(name, item.path());
        }
    }
    if directory_files.len() > options.limits.max_sql_files {
        return Err(MigrationError::new(
            "migration_sql_files_limit",
            "migration SQL file count is too large",
        ));
    }

    let allowlist = options
        .legacy_unjournaled
        .into_iter()
        .map(validate_file_name)
        .collect::<Result<Vec<_>, _>>()?;
    let allowlisted = allowlist.iter().cloned().collect::<BTreeSet<_>>();
    let unknown = directory_files
        .keys()
        .filter(|name| !journal_names.contains(*name) && !allowlisted.contains(*name))
        .cloned()
        .collect::<Vec<_>>();
    if let Some(name) = unknown.first() {
        return Err(MigrationError::new(
            "migration_sql_unknown",
            format!(
                "SQL file {} is not present in the journal or legacy allowlist",
                name
            ),
        ));
    }

    let mut entries = Vec::new();
    let mut total_bytes = 0_u64;
    for (order, journal_entry) in journal.entries.iter().enumerate() {
        let file_name = format!("{}.sql", journal_entry.tag);
        let Some(path) = directory_files.get(&file_name) else {
            return Err(MigrationError::new(
                "migration_sql_missing",
                format!("journal entry {} has no SQL file", file_name),
            ));
        };
        let bytes = read_bounded_file(
            path,
            options.limits.max_sql_file_bytes,
            "migration_sql_size_limit",
        )?;
        total_bytes = total_bytes.checked_add(bytes.len() as u64).ok_or_else(|| {
            MigrationError::new(
                "migration_sql_total_size_limit",
                "migration SQL byte count overflow",
            )
        })?;
        if total_bytes > options.limits.max_total_sql_bytes {
            return Err(MigrationError::new(
                "migration_sql_total_size_limit",
                "migration SQL is too large",
            ));
        }
        entries.push(MigrationEntry {
            order,
            file_name,
            sha256: sha256_hex(&bytes),
            byte_size: bytes.len() as u64,
            journal_entry: Some(journal_entry.clone()),
        });
    }

    for file_name in allowlist {
        let Some(path) = directory_files.get(&file_name) else {
            continue;
        };
        let bytes = read_bounded_file(
            path,
            options.limits.max_sql_file_bytes,
            "migration_sql_size_limit",
        )?;
        total_bytes = total_bytes.checked_add(bytes.len() as u64).ok_or_else(|| {
            MigrationError::new(
                "migration_sql_total_size_limit",
                "migration SQL byte count overflow",
            )
        })?;
        if total_bytes > options.limits.max_total_sql_bytes {
            return Err(MigrationError::new(
                "migration_sql_total_size_limit",
                "migration SQL is too large",
            ));
        }
        entries.push(MigrationEntry {
            order: entries.len(),
            file_name,
            sha256: sha256_hex(&bytes),
            byte_size: bytes.len() as u64,
            journal_entry: None,
        });
    }
    if entries.len() > options.limits.max_sql_files {
        return Err(MigrationError::new(
            "migration_sql_files_limit",
            "migration SQL file count is too large",
        ));
    }

    let sql_files = entries
        .iter()
        .map(|entry| entry.file_name.clone())
        .collect::<Vec<_>>();
    let fingerprint = fingerprint(&journal, &entries);
    Ok(MigrationManifest {
        journal,
        entries,
        sql_files,
        fingerprint,
    })
}

pub fn validate_migration_manifest_compatibility(
    baseline: &MigrationManifest,
    candidate: &MigrationManifest,
) -> MigrationCompatibility {
    let mut errors = Vec::new();
    let baseline_len = baseline.entries.len();
    if candidate.entries.len() < baseline_len {
        errors.push("candidate removes published migration entries".to_owned());
    }
    for (index, expected) in baseline.entries.iter().enumerate() {
        let Some(actual) = candidate.entries.get(index) else {
            break;
        };
        if expected.file_name != actual.file_name || expected.sha256 != actual.sha256 {
            errors.push(format!("candidate rewrites {}", expected.file_name));
        }
    }
    let added_entries = if candidate.entries.len() > baseline_len {
        candidate.entries[baseline_len..]
            .iter()
            .map(|entry| entry.file_name.clone())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let valid = errors.is_empty();
    MigrationCompatibility {
        valid,
        compatible: valid,
        added_entries,
        errors,
    }
}

pub fn validate_pre_mutation_requirements(
    requirements: &PreMutationRequirements,
) -> PreMutationValidation {
    let mut errors = Vec::new();
    if requirements.version != PRE_MUTATION_REQUIREMENTS_VERSION {
        errors.push("pre-mutation requirements version is unsupported".to_owned());
    }
    if !requirements.mutation_requested {
        return PreMutationValidation {
            valid: errors.is_empty(),
            errors,
            database_mutated: false,
        };
    }
    if requirements.database_non_empty {
        if requirements.lock.name != MIGRATION_ADVISORY_LOCK_NAME || !requirements.lock.acquired {
            errors.push("advisory lock must be acquired before mutation".to_owned());
        }
        if requirements.recovery.required
            && (!requirements.recovery.created
                || !requirements.recovery.includes_migration_journal
                || requirements
                    .recovery
                    .path
                    .as_deref()
                    .unwrap_or("")
                    .is_empty())
        {
            errors.push(
                "pre-mutation recovery point must exist and include the migration journal"
                    .to_owned(),
            );
        }
    }
    PreMutationValidation {
        valid: errors.is_empty(),
        errors,
        database_mutated: false,
    }
}

fn read_bounded_file(
    path: &Path,
    max_bytes: u64,
    limit_code: &'static str,
) -> Result<Vec<u8>, MigrationError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| MigrationError::new("migration_file_missing", error.to_string()))?;
    if !metadata.file_type().is_file() {
        return Err(MigrationError::new(
            "migration_file_not_regular",
            path.display().to_string(),
        ));
    }
    if metadata.len() > max_bytes {
        return Err(MigrationError::new(limit_code, path.display().to_string()));
    }
    fs::read(path)
        .map_err(|error| MigrationError::new("migration_file_unreadable", error.to_string()))
}

fn validate_file_name(name: String) -> Result<String, MigrationError> {
    if name.is_empty()
        || name.len() > 256
        || !name.ends_with(".sql")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(MigrationError::new(
            "migration_sql_unknown",
            "legacy migration file name is unsafe",
        ));
    }
    Ok(name)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fingerprint(journal: &MigrationJournal, entries: &[MigrationEntry]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(journal.version.as_bytes());
    hasher.update([0]);
    hasher.update(journal.dialect.as_bytes());
    for entry in entries {
        hasher.update(entry.order.to_le_bytes());
        hasher.update([0]);
        hasher.update(entry.file_name.as_bytes());
        hasher.update([0]);
        hasher.update(entry.sha256.as_bytes());
        hasher.update([0]);
        if let Some(journal_entry) = &entry.journal_entry {
            hasher.update(journal_entry.idx.to_le_bytes());
            hasher.update(journal_entry.when.to_le_bytes());
            hasher.update(journal_entry.tag.as_bytes());
        } else {
            hasher.update(b"legacy-unjournaled");
        }
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}
