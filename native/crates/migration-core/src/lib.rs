//! Bounded, read-only validation for Rudder's PostgreSQL migration assets.
//!
//! The validator is intentionally separate from database execution. An SQLx
//! runner can call it before taking the advisory lock or changing any row, then
//! use the resulting immutable fingerprint and ordered entries as its authority
//! input.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

pub const PRE_MUTATION_REQUIREMENTS_VERSION: u16 = 1;
pub const MIGRATION_ADVISORY_LOCK_NAME: &str = "rudder.migrations.v1";
pub const MIGRATION_MANIFEST_VERSION: u8 = 1;
pub const LEGACY_PAPERCLIP_JOURNAL_RELATIVE_PATH: &str = "meta/_journal.json";
pub const LEGACY_PAPERCLIP_MIGRATION_VERSION: &str = "7";
pub const LEGACY_PAPERCLIP_DIALECT: &str = "postgresql";
const DEFAULT_LEGACY_UNJOURNALED: [&str; 2] = [
    "0055_illegal_sheva_callister.sql",
    "0128_modern_jetstream.sql",
];
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

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

impl Default for MigrationManifestOptions {
    fn default() -> Self {
        Self {
            limits: MigrationLimits::default(),
            legacy_unjournaled: DEFAULT_LEGACY_UNJOURNALED
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MigrationInspectionOptions {
    pub manifest: MigrationManifestOptions,
    pub expected_fingerprint: Option<String>,
}

/// Explicit migration source paths. The inspector only reads this directory
/// and a journal below it; it never resolves an arbitrary path outside it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationSource {
    migrations_dir: PathBuf,
    journal_path: PathBuf,
}

impl MigrationSource {
    /// Use the current Drizzle/Paperclip-compatible source layout.
    pub fn new(migrations_dir: impl Into<PathBuf>) -> Self {
        let migrations_dir = migrations_dir.into();
        let journal_path = migrations_dir.join(LEGACY_PAPERCLIP_JOURNAL_RELATIVE_PATH);
        Self {
            migrations_dir,
            journal_path,
        }
    }

    /// Construct an explicit source pair. The inspector validates that the
    /// journal is below `migrations_dir` before reading either path.
    pub fn with_journal_path(
        migrations_dir: impl Into<PathBuf>,
        journal_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            migrations_dir: migrations_dir.into(),
            journal_path: journal_path.into(),
        }
    }

    /// Compatibility spelling for the legacy Paperclip-derived layout.
    pub fn paperclip(migrations_dir: impl Into<PathBuf>) -> Self {
        Self::new(migrations_dir)
    }

    pub fn migrations_dir(&self) -> &Path {
        &self.migrations_dir
    }

    pub fn journal_path(&self) -> &Path {
        &self.journal_path
    }
}

/// Legacy Paperclip-compatible type spelling.
pub type PaperclipMigrationSource = MigrationSource;

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
    pub version: u8,
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
    path: Option<PathBuf>,
}

impl MigrationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
        }
    }

    fn with_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.path = Some(path.into());
        self
    }

    fn io(code: &'static str, path: &Path, error: impl std::fmt::Display) -> Self {
        Self::new(code, error.to_string()).with_path(path)
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalJournalEntry {
    idx: usize,
    version: String,
    when: u64,
    tag: String,
    breakpoints: bool,
    sql_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSqlFile {
    file_name: String,
    fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalManifest {
    version: String,
    dialect: String,
    entries: Vec<CanonicalJournalEntry>,
    sql_files: Vec<CanonicalSqlFile>,
}

impl MigrationManifest {
    pub fn validate_integrity(&self) -> IntegrityResult {
        let mut errors = Vec::new();
        let mut seen = BTreeSet::new();

        if self.version != MIGRATION_MANIFEST_VERSION {
            errors.push(format!(
                "unsupported migration manifest version {}",
                self.version
            ));
        }

        if self.journal.version != LEGACY_PAPERCLIP_MIGRATION_VERSION
            || self.journal.dialect != LEGACY_PAPERCLIP_DIALECT
        {
            errors.push("journal version or dialect is unsupported".to_owned());
        }

        let mut journal_names = BTreeSet::new();
        for (expected_idx, journal_entry) in self.journal.entries.iter().enumerate() {
            if journal_entry.idx != expected_idx {
                errors.push(format!(
                    "journal entry {} has index {}, expected {}",
                    journal_entry.tag, journal_entry.idx, expected_idx
                ));
            }
            if !is_safe_tag(&journal_entry.tag) {
                errors.push(format!(
                    "journal tag {} is not a safe file stem",
                    journal_entry.tag
                ));
            }
            if journal_entry.when == 0 || journal_entry.when > MAX_SAFE_JSON_INTEGER {
                errors.push(format!(
                    "journal entry {} has an invalid timestamp",
                    journal_entry.tag
                ));
            }
            if !journal_names.insert(format!("{}.sql", journal_entry.tag)) {
                errors.push(format!(
                    "journal contains duplicate tag {}",
                    journal_entry.tag
                ));
            }
        }

        let journal_len = self.journal.entries.len();
        if self.entries.len() < journal_len {
            errors.push("manifest has fewer entries than the journal".to_owned());
        }
        for (expected_order, entry) in self.entries.iter().enumerate() {
            if entry.order != expected_order {
                errors.push(format!("entry order mismatch for {}", entry.file_name));
            }
            if !seen.insert(entry.file_name.clone()) {
                errors.push(format!("duplicate migration file {}", entry.file_name));
            }
            if !is_safe_sql_file_name(&entry.file_name) {
                errors.push(format!("invalid migration file name {}", entry.file_name));
            }
            if entry.sha256.len() != 64
                || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                errors.push(format!("invalid SHA-256 for {}", entry.file_name));
            }

            match (
                self.journal.entries.get(expected_order),
                &entry.journal_entry,
            ) {
                (Some(expected_journal), Some(actual_journal))
                    if actual_journal == expected_journal
                        && entry.file_name == format!("{}.sql", expected_journal.tag) => {}
                (Some(_), None) => {
                    errors.push(format!(
                        "journaled migration {} is classified as legacy",
                        entry.file_name
                    ));
                }
                (Some(_), Some(_)) => {
                    errors.push(format!("journal identity mismatch for {}", entry.file_name));
                }
                (None, Some(_)) => {
                    errors.push(format!(
                        "legacy migration {} carries journal identity",
                        entry.file_name
                    ));
                }
                (None, None) => {}
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

        if let Some(canonical) = canonical_manifest(self) {
            let expected_fingerprint = canonical_fingerprint(&canonical);
            if self.fingerprint != expected_fingerprint {
                errors.push(format!(
                    "manifest fingerprint mismatch: expected {expected_fingerprint}, received {}",
                    self.fingerprint
                ));
            }
        }

        IntegrityResult {
            valid: errors.is_empty(),
            errors,
        }
    }
}

/// Compatibility aliases retained for callers using Paperclip-derived names.
pub type PaperclipMigrationManifest = MigrationManifest;
pub type PaperclipMigrationJournal = MigrationJournal;

/// Inspect one explicit migration source tree without opening a database or
/// changing migration authority.
pub fn inspect_migration_source(
    source: &MigrationSource,
    options: &MigrationInspectionOptions,
) -> Result<MigrationManifest, MigrationError> {
    let manifest = load_migration_manifest_with_options(
        source.journal_path(),
        source.migrations_dir(),
        options.manifest.clone(),
    )?;
    if let Some(expected) = options.expected_fingerprint.as_deref() {
        verify_fingerprint(&manifest, expected)?;
    }
    Ok(manifest)
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
            ..MigrationManifestOptions::default()
        },
    )
}

pub fn load_migration_manifest_with_options(
    journal_path: &Path,
    migrations_dir: &Path,
    options: MigrationManifestOptions,
) -> Result<MigrationManifest, MigrationError> {
    let source = MigrationSource::with_journal_path(migrations_dir, journal_path);
    validate_source_paths(&source)?;
    let journal_bytes = read_bounded_file(
        source.journal_path(),
        options.limits.max_journal_bytes,
        "migration_journal_size_limit",
    )?;
    let journal = parse_journal(&journal_bytes)?;

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
    let directory = fs::read_dir(source.migrations_dir()).map_err(|error| {
        MigrationError::io(
            "migration_directory_unreadable",
            source.migrations_dir(),
            error,
        )
    })?;
    let mut directory_entry_count = 0_usize;
    for item in directory {
        directory_entry_count = directory_entry_count.saturating_add(1);
        if directory_entry_count > options.limits.max_directory_entries {
            return Err(MigrationError::new(
                "migration_directory_entries_limit",
                "migration directory is too large",
            )
            .with_path(source.migrations_dir()));
        }
        let item = item.map_err(|error| {
            MigrationError::io(
                "migration_directory_unreadable",
                source.migrations_dir(),
                error,
            )
        })?;
        let file_type = item.file_type().map_err(|error| {
            MigrationError::io("migration_file_metadata_failed", &item.path(), error)
        })?;
        if file_type.is_symlink() {
            return Err(MigrationError::new(
                "migration_symlink_rejected",
                "migration source contains a symlink",
            )
            .with_path(item.path()));
        }
        let name = item
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                MigrationError::new(
                    "migration_file_name_invalid",
                    "migration source contains a non-UTF-8 file name",
                )
                .with_path(item.path())
            })?;
        if !file_type.is_file() {
            if name.ends_with(".sql") {
                return Err(MigrationError::new(
                    "migration_sql_not_regular",
                    format!("SQL entry {name} is not a regular file"),
                )
                .with_path(item.path()));
            }
            continue;
        }
        if name.ends_with(".sql") {
            if !is_safe_sql_file_name(&name) {
                return Err(MigrationError::new(
                    "migration_sql_path_invalid",
                    format!("SQL file {name} is not a safe direct child"),
                )
                .with_path(item.path()));
            }
            if directory_files.insert(name.clone(), item.path()).is_some() {
                return Err(MigrationError::new(
                    "migration_sql_duplicate",
                    format!("migration source repeats {name}"),
                )
                .with_path(item.path()));
            }
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
    let fingerprint = manifest_fingerprint(&journal, &entries);
    Ok(MigrationManifest {
        version: MIGRATION_MANIFEST_VERSION,
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
    errors.extend(
        baseline
            .validate_integrity()
            .errors
            .into_iter()
            .map(|error| format!("Baseline: {error}")),
    );
    errors.extend(
        candidate
            .validate_integrity()
            .errors
            .into_iter()
            .map(|error| format!("Candidate: {error}")),
    );

    if candidate.journal.entries.len() < baseline.journal.entries.len() {
        errors.push("candidate removes published journal migrations".to_owned());
    }

    for (index, expected_journal) in baseline.journal.entries.iter().enumerate() {
        let Some(actual_journal) = candidate.journal.entries.get(index) else {
            break;
        };
        let expected = baseline.entries.get(index);
        let actual = candidate.entries.get(index);
        if expected_journal != actual_journal
            || expected.map(|entry| (&entry.file_name, &entry.sha256))
                != actual.map(|entry| (&entry.file_name, &entry.sha256))
        {
            errors.push(format!(
                "candidate rewrites published journal migration {}.sql",
                expected_journal.tag
            ));
        }
    }

    let baseline_legacy = baseline
        .entries
        .iter()
        .filter(|entry| entry.journal_entry.is_none())
        .collect::<Vec<_>>();
    let candidate_legacy = candidate
        .entries
        .iter()
        .filter(|entry| entry.journal_entry.is_none())
        .collect::<Vec<_>>();
    if candidate_legacy.len() != baseline_legacy.len() {
        if candidate_legacy.len() < baseline_legacy.len() {
            errors.push("candidate removes published legacy migrations".to_owned());
        } else {
            errors.push("candidate adds unpublished legacy migrations".to_owned());
        }
    }
    for (index, expected) in baseline_legacy.iter().enumerate() {
        let Some(actual) = candidate_legacy.get(index) else {
            break;
        };
        if expected.file_name != actual.file_name || expected.sha256 != actual.sha256 {
            errors.push(format!("candidate rewrites {}", expected.file_name));
        }
    }

    let baseline_journal_len = baseline.journal.entries.len();
    let candidate_journal_len = candidate.journal.entries.len();
    let added_entries = if candidate_journal_len > baseline_journal_len
        && candidate.entries.len() >= candidate_journal_len
    {
        candidate.entries[baseline_journal_len..candidate_journal_len]
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMigrationJournal {
    version: Value,
    dialect: String,
    entries: Vec<JournalEntry>,
}

fn parse_journal(bytes: &[u8]) -> Result<MigrationJournal, MigrationError> {
    let raw: RawMigrationJournal = serde_json::from_slice(bytes)
        .map_err(|error| MigrationError::new("migration_journal_invalid", error.to_string()))?;
    let version = match raw.version {
        Value::String(value) => value,
        Value::Number(value) => value
            .as_u64()
            .map(|value| value.to_string())
            .or_else(|| {
                value
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
                    .map(|value| (value as u64).to_string())
            })
            .ok_or_else(|| {
                MigrationError::new(
                    "migration_journal_invalid",
                    "journal version must be a safe integer or string",
                )
            })?,
        _ => {
            return Err(MigrationError::new(
                "migration_journal_invalid",
                "journal version must be a string or number",
            ));
        }
    };
    if version != LEGACY_PAPERCLIP_MIGRATION_VERSION || raw.dialect != LEGACY_PAPERCLIP_DIALECT {
        return Err(MigrationError::new(
            "migration_journal_invalid",
            "journal version or dialect is unsupported",
        ));
    }

    let mut seen_tags = BTreeSet::new();
    for (expected_idx, entry) in raw.entries.iter().enumerate() {
        if entry.idx != expected_idx {
            return Err(MigrationError::new(
                "migration_journal_reordered",
                format!(
                    "journal entry {} has index {}, expected {}",
                    entry.tag, entry.idx, expected_idx
                ),
            ));
        }
        if !is_safe_tag(&entry.tag) {
            return Err(MigrationError::new(
                "migration_journal_path_invalid",
                format!("journal tag {} is not a safe file stem", entry.tag),
            ));
        }
        if entry.version.is_empty() {
            return Err(MigrationError::new(
                "migration_journal_invalid",
                format!("journal entry {} has an empty version", entry.tag),
            ));
        }
        if entry.when == 0 || entry.when > MAX_SAFE_JSON_INTEGER {
            return Err(MigrationError::new(
                "migration_journal_invalid",
                format!("journal entry {} has an invalid timestamp", entry.tag),
            ));
        }
        if !seen_tags.insert(entry.tag.clone()) {
            return Err(MigrationError::new(
                "migration_journal_duplicate",
                format!("journal contains duplicate tag {}", entry.tag),
            ));
        }
    }
    Ok(MigrationJournal {
        version,
        dialect: raw.dialect,
        entries: raw.entries,
    })
}

fn validate_source_paths(source: &MigrationSource) -> Result<(), MigrationError> {
    let root_metadata = fs::symlink_metadata(source.migrations_dir()).map_err(|error| {
        MigrationError::io(
            "migration_directory_unreadable",
            source.migrations_dir(),
            error,
        )
    })?;
    if root_metadata.file_type().is_symlink() {
        return Err(MigrationError::new(
            "migration_symlink_rejected",
            "migration directory must not be a symlink",
        )
        .with_path(source.migrations_dir()));
    }
    if !root_metadata.is_dir() {
        return Err(MigrationError::new(
            "migration_directory_invalid",
            "migration source is not a directory",
        )
        .with_path(source.migrations_dir()));
    }

    let relative = source
        .journal_path()
        .strip_prefix(source.migrations_dir())
        .map_err(|_| {
            MigrationError::new(
                "migration_journal_outside_root",
                "journal path must be inside the migration directory",
            )
            .with_path(source.journal_path())
        })?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MigrationError::new(
            "migration_journal_path_invalid",
            "journal path must be a relative file below the migration directory",
        )
        .with_path(source.journal_path()));
    }
    reject_symlink_components(source.migrations_dir(), relative)?;
    Ok(())
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), MigrationError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(name) => {
                current.push(name);
                match fs::symlink_metadata(&current) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(MigrationError::new(
                            "migration_symlink_rejected",
                            "migration source path contains a symlink",
                        )
                        .with_path(current));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(error) => {
                        return Err(MigrationError::io(
                            "migration_file_metadata_failed",
                            &current,
                            error,
                        ));
                    }
                }
            }
            Component::ParentDir => {
                return Err(MigrationError::new(
                    "migration_path_invalid",
                    "source path contains a parent-directory component",
                )
                .with_path(root));
            }
            Component::Prefix(_) | Component::RootDir | Component::CurDir => {
                return Err(MigrationError::new(
                    "migration_path_invalid",
                    "source path contains a non-normal component",
                )
                .with_path(root));
            }
        }
    }
    Ok(())
}

fn read_bounded_file(
    path: &Path,
    max_bytes: u64,
    limit_code: &'static str,
) -> Result<Vec<u8>, MigrationError> {
    let file = open_bounded_file(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return MigrationError::new(
                "migration_symlink_rejected",
                "migration source file must not be a symlink",
            )
            .with_path(path);
        }
        MigrationError::io("migration_file_missing", path, error)
    })?;
    let metadata = file
        .metadata()
        .map_err(|error| MigrationError::io("migration_file_metadata_failed", path, error))?;
    if metadata.file_type().is_symlink() {
        return Err(MigrationError::new(
            "migration_symlink_rejected",
            "migration source file must not be a symlink",
        )
        .with_path(path));
    }
    if !metadata.is_file() {
        return Err(MigrationError::new(
            "migration_file_not_regular",
            path.display().to_string(),
        ));
    }
    if metadata.len() > max_bytes {
        return Err(MigrationError::new(limit_code, path.display().to_string()));
    }
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| MigrationError::io("migration_file_unreadable", path, error))?;
    if bytes.len() as u64 > max_bytes {
        return Err(
            MigrationError::new(limit_code, "migration source exceeds its size limit")
                .with_path(path),
        );
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_bounded_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn open_bounded_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_bounded_file(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

fn validate_file_name(name: String) -> Result<String, MigrationError> {
    if !is_safe_sql_file_name(&name) || name.len() > 256 {
        return Err(MigrationError::new(
            "migration_sql_unknown",
            "legacy migration file name is unsafe",
        ));
    }
    Ok(name)
}

fn is_safe_tag(tag: &str) -> bool {
    let mut chars = tag.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && chars
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn is_safe_sql_file_name(name: &str) -> bool {
    name.strip_suffix(".sql").is_some_and(is_safe_tag)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn canonical_manifest(manifest: &MigrationManifest) -> Option<CanonicalManifest> {
    let mut journal_entries = Vec::with_capacity(manifest.journal.entries.len());
    if manifest.entries.len() < manifest.journal.entries.len()
        || manifest
            .entries
            .iter()
            .skip(manifest.journal.entries.len())
            .any(|entry| entry.journal_entry.is_some())
    {
        return None;
    }
    for (position, journal_entry) in manifest.journal.entries.iter().enumerate() {
        let file_name = format!("{}.sql", journal_entry.tag);
        let entry = manifest.entries.get(position)?;
        if entry.file_name != file_name || entry.journal_entry.as_ref() != Some(journal_entry) {
            return None;
        }
        journal_entries.push(CanonicalJournalEntry {
            idx: journal_entry.idx,
            version: journal_entry.version.clone(),
            when: journal_entry.when,
            tag: journal_entry.tag.clone(),
            breakpoints: journal_entry.breakpoints,
            sql_fingerprint: entry.sha256.clone(),
        });
    }

    let mut sql_files = manifest
        .entries
        .iter()
        .map(|entry| CanonicalSqlFile {
            file_name: entry.file_name.clone(),
            fingerprint: entry.sha256.clone(),
        })
        .collect::<Vec<_>>();
    sql_files.sort_by(|left, right| left.file_name.cmp(&right.file_name));

    Some(CanonicalManifest {
        version: manifest.journal.version.clone(),
        dialect: manifest.journal.dialect.clone(),
        entries: journal_entries,
        sql_files,
    })
}

fn manifest_fingerprint(journal: &MigrationJournal, entries: &[MigrationEntry]) -> String {
    let manifest = MigrationManifest {
        version: MIGRATION_MANIFEST_VERSION,
        journal: journal.clone(),
        entries: entries.to_vec(),
        sql_files: entries
            .iter()
            .map(|entry| entry.file_name.clone())
            .collect(),
        fingerprint: String::new(),
    };
    let canonical = canonical_manifest(&manifest)
        .expect("loaded migration manifest must have canonical journal entries");
    canonical_fingerprint(&canonical)
}

fn canonical_fingerprint(canonical: &CanonicalManifest) -> String {
    let bytes = serde_json::to_vec(canonical).expect("canonical manifest is serializable");
    sha256_hex(&bytes)
}

fn verify_fingerprint(manifest: &MigrationManifest, expected: &str) -> Result<(), MigrationError> {
    if !is_sha256_hex(expected) {
        return Err(MigrationError::new(
            "migration_fingerprint_invalid",
            "expected fingerprint must be 64 hexadecimal characters",
        ));
    }
    if !manifest.fingerprint.eq_ignore_ascii_case(expected) {
        return Err(MigrationError::new(
            "migration_fingerprint_mismatch",
            format!("expected {expected}, loaded {}", manifest.fingerprint),
        ));
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
