use rudder_cli_mcp_contract_core::{
    DEFAULT_WORKSPACE_MAX_ENTRIES, DEFAULT_WORKSPACE_MAX_PATH_BYTES, WorkspaceListRequest,
    list_workspace_directory,
};
use rudder_migration_runner::{
    MigrationInspection, MigrationSource, RUNNER_PROTOCOL_VERSION, inspect_migration_sources,
};
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::path::Path;

const WORKSPACE_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug)]
struct CliError {
    code: String,
    message: String,
}

impl CliError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Default)]
struct WorkspaceListOptions {
    root: Option<String>,
    directory: Option<String>,
    max_entries: Option<u64>,
    max_path_bytes: Option<u64>,
    positional: Vec<String>,
}

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") if args.next().is_none() => {
            println!("rudder-cli {}", env!("CARGO_PKG_VERSION"));
        }
        Some("--help") if args.next().is_none() => {
            println!("{}", usage());
        }
        Some("workspace") => match (args.next().as_deref(), args.next()) {
            (Some("list"), first) => {
                let mut remaining = first.into_iter().chain(args);
                match run_workspace_list(&mut remaining) {
                    Ok(response) => println!("{response}"),
                    Err(error) => {
                        println!("{}", workspace_error(&error));
                        eprintln!("rudder-cli: {}", error.message);
                        std::process::exit(2);
                    }
                }
            }
            _ => exit_usage(),
        },
        Some("migration") => match args.next().as_deref() {
            Some("inspect" | "status") => match run_migration_inspect(&mut args) {
                Ok(report) => {
                    let valid = report.valid();
                    println!("{}", migration_response(&report));
                    if !valid {
                        eprintln!(
                            "rudder-cli: migration inspection failed: {}",
                            report.errors.join("; ")
                        );
                        std::process::exit(2);
                    }
                }
                Err(error) => {
                    println!("{}", migration_error(&error));
                    eprintln!("rudder-cli: {}", error.message);
                    std::process::exit(2);
                }
            },
            _ => exit_usage(),
        },
        _ => exit_usage(),
    }
}

fn usage() -> &'static str {
    "usage: rudder-cli --version | workspace list [ROOT] [DIRECTORY] [MAX_ENTRIES] [MAX_PATH_BYTES] [--root PATH] [--directory PATH] [--max-entries N] [--max-path-bytes N] | migration inspect --journal PATH --migrations-dir PATH [--baseline-journal PATH --baseline-migrations-dir PATH] [--expected-fingerprint HEX] [--baseline-fingerprint HEX] [--json]"
}

fn exit_usage() -> ! {
    eprintln!("{usage}", usage = usage());
    std::process::exit(2);
}

fn run_workspace_list(arguments: &mut impl Iterator<Item = String>) -> Result<Value, CliError> {
    let options = parse_workspace_options(arguments)?;
    let root = options
        .root
        .or_else(|| env::var("RUDDER_PROJECT_LIBRARY_PATH").ok())
        .ok_or_else(|| {
            CliError::new(
                "workspace_root_required",
                "workspace root must be supplied by the host or --root",
            )
        })?;
    let root = root.trim();
    if root.is_empty() {
        return Err(CliError::new(
            "workspace_root_required",
            "workspace root must not be empty",
        ));
    }
    if !Path::new(root).is_absolute() {
        return Err(CliError::new(
            "workspace_root_must_be_absolute",
            "workspace root must be an absolute path",
        ));
    }

    let directory = options
        .directory
        .or_else(|| options.positional.get(1).cloned())
        .unwrap_or_else(|| "projects".to_owned());
    let max_entries = options
        .max_entries
        .or(parse_positional_u64(&options.positional, 2, "max_entries")?)
        .unwrap_or(DEFAULT_WORKSPACE_MAX_ENTRIES);
    let max_path_bytes = options
        .max_path_bytes
        .or(parse_positional_u64(
            &options.positional,
            3,
            "max_path_bytes",
        )?)
        .unwrap_or(DEFAULT_WORKSPACE_MAX_PATH_BYTES);

    let request = WorkspaceListRequest::from_json(&json!({
        "directory": directory,
        "maxEntries": max_entries,
        "maxPathBytes": max_path_bytes,
    }))
    .map_err(|error| CliError::new(error.code(), error.message()))?;
    let result = list_workspace_directory(Path::new(root), &request)
        .map_err(|error| CliError::new(error.code(), error.message()))?;

    Ok(json!({
        "ok": true,
        "capability": "workspace.list",
        "operation": "listWorkspaceDirectory",
        "protocolVersion": WORKSPACE_PROTOCOL_VERSION,
        "accepted": false,
        "directoryPath": result.directory_path,
        "entries": result.entries,
    }))
}

fn parse_workspace_options(
    arguments: &mut impl Iterator<Item = String>,
) -> Result<WorkspaceListOptions, CliError> {
    let mut options = WorkspaceListOptions::default();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--root" | "-r" => {
                options.root = Some(required_option(arguments, "--root")?);
            }
            "--directory" | "-d" => {
                options.directory = Some(required_option(arguments, "--directory")?);
            }
            "--max-entries" | "--maxEntries" => {
                options.max_entries = Some(parse_option_u64(
                    required_option(arguments, "--max-entries")?,
                    "max_entries",
                )?);
            }
            "--max-path-bytes" | "--maxPathBytes" => {
                options.max_path_bytes = Some(parse_option_u64(
                    required_option(arguments, "--max-path-bytes")?,
                    "max_path_bytes",
                )?);
            }
            "--json" => {}
            value if value.starts_with('-') => {
                return Err(CliError::new(
                    "unknown_option",
                    format!("unknown workspace list option {value}"),
                ));
            }
            value => options.positional.push(value.to_owned()),
        }
    }
    if options.positional.len() > 4 {
        return Err(CliError::new(
            "usage",
            "workspace list accepts at most four positional arguments",
        ));
    }
    if options.root.is_some() && !options.positional.is_empty() {
        return Err(CliError::new(
            "usage",
            "workspace root must be positional or --root, not both",
        ));
    }
    if options.directory.is_some() && options.positional.len() > 1 {
        return Err(CliError::new(
            "usage",
            "workspace directory must be positional or --directory, not both",
        ));
    }
    if options.max_entries.is_some() && options.positional.len() > 2 {
        return Err(CliError::new(
            "usage",
            "workspace entry limit must be positional or --max-entries, not both",
        ));
    }
    if options.max_path_bytes.is_some() && options.positional.len() > 3 {
        return Err(CliError::new(
            "usage",
            "workspace path limit must be positional or --max-path-bytes, not both",
        ));
    }
    if options.root.is_none() && !options.positional.is_empty() {
        options.root = options.positional.first().cloned();
    }
    Ok(options)
}

fn required_option(
    arguments: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<String, CliError> {
    arguments
        .next()
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| CliError::new("usage", format!("{option} requires a value")))
}

fn parse_option_u64(value: String, name: &str) -> Result<u64, CliError> {
    value.parse::<u64>().map_err(|_| {
        CliError::new(
            "invalid_limit",
            format!("{name} must be an unsigned integer"),
        )
    })
}

fn parse_positional_u64(
    positional: &[String],
    index: usize,
    name: &str,
) -> Result<Option<u64>, CliError> {
    positional
        .get(index)
        .map(|value| parse_option_u64(value.clone(), name))
        .transpose()
}

#[derive(Debug, Default)]
struct MigrationInspectOptions {
    journal: Option<String>,
    migrations_dir: Option<String>,
    baseline_journal: Option<String>,
    baseline_migrations_dir: Option<String>,
    expected_fingerprint: Option<String>,
    baseline_fingerprint: Option<String>,
}

fn parse_migration_inspect_options(
    arguments: &mut impl Iterator<Item = String>,
) -> Result<MigrationInspectOptions, CliError> {
    let mut options = MigrationInspectOptions::default();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--journal" => set_migration_option(&mut options.journal, arguments, "--journal")?,
            "--migrations-dir" => {
                set_migration_option(&mut options.migrations_dir, arguments, "--migrations-dir")?
            }
            "--baseline-journal" => set_migration_option(
                &mut options.baseline_journal,
                arguments,
                "--baseline-journal",
            )?,
            "--baseline-migrations-dir" => set_migration_option(
                &mut options.baseline_migrations_dir,
                arguments,
                "--baseline-migrations-dir",
            )?,
            "--expected-fingerprint" => set_migration_option(
                &mut options.expected_fingerprint,
                arguments,
                "--expected-fingerprint",
            )?,
            "--baseline-fingerprint" => set_migration_option(
                &mut options.baseline_fingerprint,
                arguments,
                "--baseline-fingerprint",
            )?,
            "--json" => {}
            value if value.starts_with('-') => {
                return Err(CliError::new(
                    "unknown_option",
                    format!("unknown migration inspect option {value}"),
                ));
            }
            value => {
                return Err(CliError::new(
                    "usage",
                    format!("migration inspect does not accept positional argument {value}"),
                ));
            }
        }
    }

    if options.journal.is_none() || options.migrations_dir.is_none() {
        return Err(CliError::new(
            "usage",
            "migration inspect requires --journal and --migrations-dir",
        ));
    }
    if options.baseline_journal.is_some() != options.baseline_migrations_dir.is_some() {
        return Err(CliError::new(
            "usage",
            "--baseline-journal and --baseline-migrations-dir must be supplied together",
        ));
    }
    if options.baseline_fingerprint.is_some() && options.baseline_journal.is_none() {
        return Err(CliError::new(
            "usage",
            "--baseline-fingerprint requires an explicit baseline",
        ));
    }
    if let Some(fingerprint) = options.expected_fingerprint.as_deref() {
        validate_fingerprint(fingerprint, "expected fingerprint")?;
    }
    if let Some(fingerprint) = options.baseline_fingerprint.as_deref() {
        validate_fingerprint(fingerprint, "baseline fingerprint")?;
    }
    Ok(options)
}

fn set_migration_option(
    slot: &mut Option<String>,
    arguments: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<(), CliError> {
    if slot.is_some() {
        return Err(CliError::new(
            "usage",
            format!("{option} may only be supplied once"),
        ));
    }
    *slot = Some(required_option(arguments, option)?);
    Ok(())
}

fn validate_fingerprint(value: &str, name: &str) -> Result<(), CliError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CliError::new(
            "invalid_fingerprint",
            format!("{name} must be a 64-character hexadecimal SHA-256"),
        ));
    }
    Ok(())
}

fn validate_migration_path(path: &str, option: &str, directory: bool) -> Result<(), CliError> {
    let path_ref = Path::new(path);
    if path.is_empty() {
        return Err(CliError::new(
            "usage",
            format!("{option} must not be empty"),
        ));
    }
    if !path_ref.is_absolute() {
        return Err(CliError::new(
            "migration_path_must_be_absolute",
            format!("{option} must be an absolute path"),
        ));
    }
    let metadata = fs::symlink_metadata(path_ref).map_err(|error| {
        CliError::new(
            if directory {
                "migration_directory_unreadable"
            } else {
                "migration_file_missing"
            },
            format!("{option}: {error}"),
        )
    })?;
    let is_expected_type = if directory {
        metadata.file_type().is_dir()
    } else {
        metadata.file_type().is_file()
    };
    if !is_expected_type {
        return Err(CliError::new(
            if directory {
                "migration_directory_unreadable"
            } else {
                "migration_file_not_regular"
            },
            format!("{option} is not the required path type"),
        ));
    }
    Ok(())
}

fn run_migration_inspect(
    arguments: &mut impl Iterator<Item = String>,
) -> Result<MigrationInspection, CliError> {
    let options = parse_migration_inspect_options(arguments)?;
    let journal = options
        .journal
        .as_deref()
        .expect("parser requires a journal path");
    let migrations_dir = options
        .migrations_dir
        .as_deref()
        .expect("parser requires a migrations directory");
    validate_migration_path(journal, "--journal", false)?;
    validate_migration_path(migrations_dir, "--migrations-dir", true)?;

    let mut candidate = MigrationSource::with_default_options(journal, migrations_dir);
    if let Some(fingerprint) = options.expected_fingerprint {
        candidate = candidate.with_expected_fingerprint(fingerprint);
    }

    let baseline = match (options.baseline_journal, options.baseline_migrations_dir) {
        (Some(journal), Some(migrations_dir)) => {
            validate_migration_path(&journal, "--baseline-journal", false)?;
            validate_migration_path(&migrations_dir, "--baseline-migrations-dir", true)?;
            let mut source = MigrationSource::with_default_options(journal, migrations_dir);
            if let Some(fingerprint) = options.baseline_fingerprint {
                source = source.with_expected_fingerprint(fingerprint);
            }
            Some(source)
        }
        (None, None) => None,
        _ => unreachable!("parser validates baseline option pairs"),
    };

    inspect_migration_sources(candidate, baseline)
        .map_err(|error| CliError::new(error.code(), error.message()))
}

fn migration_response(report: &MigrationInspection) -> Value {
    let valid = report.valid();
    let outcome = if valid { "valid" } else { "incompatible" };
    let error_code = if valid {
        Value::Null
    } else {
        json!("migration_manifest_incompatible")
    };
    let message = if valid {
        Value::Null
    } else {
        json!(report.errors.join("; "))
    };
    json!({
        "ok": valid,
        "capability": "migration.inspect",
        "operation": "inspectMigrationManifest",
        "protocolVersion": report.protocol_version,
        "accepted": false,
        "candidateFingerprint": report.candidate_fingerprint,
        "baselineFingerprint": report.baseline_fingerprint,
        "counts": {
            "journalEntries": report.candidate_journal_entries,
            "manifestEntries": report.candidate_manifest_entries,
            "sqlFiles": report.candidate_sql_files,
            "legacyUnjournaled": report.candidate_legacy_unjournaled,
            "baselineJournalEntries": report.baseline_journal_entries,
            "baselineEntries": report.baseline_manifest_entries,
            "baselineSqlFiles": report.baseline_sql_files,
            "baselineLegacyUnjournaled": report.baseline_legacy_unjournaled,
            "addedEntries": report.added_entries.len(),
        },
        "addedEntries": report.added_entries,
        "validationOutcome": outcome,
        "validation": {
            "manifestValid": true,
            "compatibilityChecked": report.compatibility_checked,
            "compatible": report.compatible,
            "outcome": outcome,
            "errors": report.errors,
        },
        "errorCode": error_code,
        "message": message,
    })
}

fn migration_error(error: &CliError) -> Value {
    json!({
        "ok": false,
        "capability": "migration.inspect",
        "operation": "inspectMigrationManifest",
        "protocolVersion": RUNNER_PROTOCOL_VERSION,
        "accepted": false,
        "candidateFingerprint": Value::Null,
        "baselineFingerprint": Value::Null,
        "counts": {
            "journalEntries": 0,
            "manifestEntries": 0,
            "sqlFiles": 0,
            "legacyUnjournaled": 0,
            "baselineJournalEntries": Value::Null,
            "baselineEntries": Value::Null,
            "baselineSqlFiles": Value::Null,
            "baselineLegacyUnjournaled": Value::Null,
            "addedEntries": 0,
        },
        "addedEntries": [],
        "validationOutcome": "invalid",
        "validation": {
            "manifestValid": false,
            "compatibilityChecked": false,
            "compatible": false,
            "outcome": "invalid",
            "errors": [error.message],
        },
        "errorCode": error.code,
        "message": error.message,
    })
}

fn workspace_error(error: &CliError) -> Value {
    json!({
        "ok": false,
        "capability": "workspace.list",
        "operation": "listWorkspaceDirectory",
        "protocolVersion": WORKSPACE_PROTOCOL_VERSION,
        "accepted": false,
        "errorCode": error.code,
        "message": error.message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_inspect_requires_both_explicit_source_paths() {
        let mut arguments = ["--journal", "/tmp/journal.json"]
            .into_iter()
            .map(str::to_owned);
        let error = parse_migration_inspect_options(&mut arguments).unwrap_err();
        assert_eq!(error.code, "usage");
    }

    #[test]
    fn migration_inspect_rejects_partial_baseline_and_unknown_options() {
        let mut partial_baseline = [
            "--journal",
            "/tmp/journal.json",
            "--migrations-dir",
            "/tmp/migrations",
            "--baseline-journal",
            "/tmp/baseline.json",
        ]
        .into_iter()
        .map(str::to_owned);
        let error = parse_migration_inspect_options(&mut partial_baseline).unwrap_err();
        assert_eq!(error.code, "usage");

        let mut unknown = [
            "--journal",
            "/tmp/journal.json",
            "--migrations-dir",
            "/tmp/migrations",
            "--password",
            "secret",
        ]
        .into_iter()
        .map(str::to_owned);
        let error = parse_migration_inspect_options(&mut unknown).unwrap_err();
        assert_eq!(error.code, "unknown_option");
    }
}
