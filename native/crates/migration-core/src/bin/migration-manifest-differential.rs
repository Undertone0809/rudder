use rudder_migration_core::{
    inspect_migration_source, load_migration_manifest, validate_migration_manifest_compatibility,
    JournalEntry, MigrationCompatibility, MigrationInspectionOptions, MigrationLimits,
    MigrationManifest, MigrationManifestOptions, MigrationSource,
};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::PathBuf;

const SCHEMA: &str = "rudder.migration-manifest.differential/v1";
const PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DifferentialRequest {
    schema: String,
    protocol_version: u8,
    baseline: SourceSpec,
    candidate: SourceSpec,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceSpec {
    migrations_dir: String,
    journal_file: Option<String>,
    expected_fingerprint: Option<String>,
    limits: Option<LimitSpec>,
    legacy_unjournaled: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LimitSpec {
    max_journal_bytes: Option<u64>,
    max_sql_file_bytes: Option<u64>,
    max_total_sql_bytes: Option<u64>,
    max_sql_files: Option<usize>,
    max_directory_entries: Option<usize>,
}

impl SourceSpec {
    fn source(&self) -> MigrationSource {
        let migrations_dir = PathBuf::from(&self.migrations_dir);
        match &self.journal_file {
            Some(journal_file) => MigrationSource::with_journal_path(migrations_dir, journal_file),
            None => MigrationSource::new(migrations_dir),
        }
    }

    fn limits(&self) -> MigrationLimits {
        let mut limits = MigrationLimits::default();
        if let Some(spec) = &self.limits {
            if let Some(value) = spec.max_journal_bytes {
                limits.max_journal_bytes = value;
            }
            if let Some(value) = spec.max_sql_file_bytes {
                limits.max_sql_file_bytes = value;
            }
            if let Some(value) = spec.max_total_sql_bytes {
                limits.max_total_sql_bytes = value;
            }
            if let Some(value) = spec.max_sql_files {
                limits.max_sql_files = value;
            }
            if let Some(value) = spec.max_directory_entries {
                limits.max_directory_entries = value;
            }
        }
        limits
    }

    fn inspection_options(&self) -> MigrationInspectionOptions {
        let defaults = MigrationManifestOptions::default();
        MigrationInspectionOptions {
            manifest: MigrationManifestOptions {
                limits: self.limits(),
                legacy_unjournaled: self
                    .legacy_unjournaled
                    .clone()
                    .unwrap_or(defaults.legacy_unjournaled),
            },
            expected_fingerprint: self.expected_fingerprint.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntryProjection {
    idx: usize,
    version: String,
    when: u64,
    tag: String,
    breakpoints: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalJournalEntryProjection {
    idx: usize,
    version: String,
    when: u64,
    tag: String,
    breakpoints: bool,
    sql_fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSqlFileProjection {
    file_name: String,
    fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalProjection {
    version: String,
    dialect: String,
    entries: Vec<CanonicalJournalEntryProjection>,
    sql_files: Vec<CanonicalSqlFileProjection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrderedEntryProjection {
    order: usize,
    file_name: String,
    sha256: String,
    byte_size: u64,
    journal_entry: Option<JournalEntryProjection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestProjection {
    version: u8,
    fingerprint: String,
    canonical: CanonicalProjection,
    entries: Vec<OrderedEntryProjection>,
    legacy_tail: Vec<OrderedEntryProjection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceError {
    classification: &'static str,
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<ManifestProjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SourceError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityReport {
    classification: &'static str,
    valid: bool,
    compatible: bool,
    added_entries: Vec<OrderedEntryProjection>,
    errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolError {
    classification: &'static str,
    code: &'static str,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DifferentialResponse {
    schema: &'static str,
    protocol_version: u8,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    baseline: Option<SourceResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate: Option<SourceResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compatibility: Option<CompatibilityReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ProtocolError>,
}

#[derive(Debug)]
struct RequestError {
    code: &'static str,
    message: String,
}

fn main() {
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        emit_protocol_error(RequestError {
            code: "stdin_read_failed",
            message: error.to_string(),
        });
        return;
    }

    let request = match parse_request(&input) {
        Ok(request) => request,
        Err(error) => {
            emit_protocol_error(error);
            return;
        }
    };
    let response = execute(request);
    let failed = response.status == "error";
    println!(
        "{}",
        serde_json::to_string(&response).expect("differential response is serializable")
    );
    if failed {
        std::process::exit(1);
    }
}

fn parse_request(input: &str) -> Result<DifferentialRequest, RequestError> {
    let request =
        serde_json::from_str::<DifferentialRequest>(input).map_err(|error| RequestError {
            code: if error.is_syntax() || error.is_eof() {
                "invalid_json"
            } else {
                "invalid_request"
            },
            message: error.to_string(),
        })?;
    if request.schema != SCHEMA {
        return Err(RequestError {
            code: "unsupported_schema",
            message: format!("expected {SCHEMA}, received {}", request.schema),
        });
    }
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(RequestError {
            code: "unsupported_protocol_version",
            message: format!(
                "expected {PROTOCOL_VERSION}, received {}",
                request.protocol_version
            ),
        });
    }
    Ok(request)
}

fn execute(request: DifferentialRequest) -> DifferentialResponse {
    let baseline_result = load_baseline(&request.baseline);
    let candidate_result = inspect_source(&request.candidate);
    let baseline = Some(source_response(&baseline_result));
    let candidate = Some(source_response(&candidate_result));
    let compatibility = match (&baseline_result, &candidate_result) {
        (Ok(baseline), Ok(candidate)) => Some(compatibility_report(
            &validate_migration_manifest_compatibility(baseline, candidate),
            candidate,
        )),
        _ => None,
    };
    let status = if baseline_result.is_ok() && candidate_result.is_ok() {
        "ok"
    } else {
        "error"
    };

    DifferentialResponse {
        schema: SCHEMA,
        protocol_version: PROTOCOL_VERSION,
        status,
        baseline,
        candidate,
        compatibility,
        error: None,
    }
}

fn load_baseline(
    spec: &SourceSpec,
) -> Result<MigrationManifest, rudder_migration_core::MigrationError> {
    let source = spec.source();
    if spec.expected_fingerprint.is_none()
        && spec.limits.is_none()
        && spec.legacy_unjournaled.is_none()
    {
        load_migration_manifest(
            source.journal_path(),
            source.migrations_dir(),
            MigrationLimits::default(),
        )
    } else {
        inspect_migration_source(&source, &spec.inspection_options())
    }
}

fn inspect_source(
    spec: &SourceSpec,
) -> Result<MigrationManifest, rudder_migration_core::MigrationError> {
    let source = spec.source();
    inspect_migration_source(&source, &spec.inspection_options())
}

fn source_response(
    result: &Result<MigrationManifest, rudder_migration_core::MigrationError>,
) -> SourceResponse {
    match result {
        Ok(manifest) => SourceResponse {
            status: "ok",
            manifest: Some(project_manifest(manifest)),
            error: None,
        },
        Err(error) => SourceResponse {
            status: "error",
            manifest: None,
            error: Some(SourceError {
                classification: classify_source_error(error.code()),
                code: error.code().to_owned(),
                message: error.message().to_owned(),
                path: error.path().map(|path| path.display().to_string()),
            }),
        },
    }
}

fn compatibility_report(
    compatibility: &MigrationCompatibility,
    candidate: &MigrationManifest,
) -> CompatibilityReport {
    let added_entries = compatibility
        .added_entries
        .iter()
        .filter_map(|file_name| {
            candidate
                .entries
                .iter()
                .find(|entry| &entry.file_name == file_name)
        })
        .map(project_entry)
        .collect();
    let classification = if !compatibility.valid {
        "incompatible"
    } else if compatibility.added_entries.is_empty() {
        "compatible_noop"
    } else {
        "compatible_append"
    };
    CompatibilityReport {
        classification,
        valid: compatibility.valid,
        compatible: compatibility.compatible,
        added_entries,
        errors: compatibility.errors.clone(),
    }
}

fn project_manifest(manifest: &MigrationManifest) -> ManifestProjection {
    let entries = manifest
        .entries
        .iter()
        .map(project_entry)
        .collect::<Vec<_>>();
    let legacy_tail = entries
        .iter()
        .filter(|entry| entry.journal_entry.is_none())
        .cloned()
        .collect();
    let canonical = CanonicalProjection {
        version: manifest.journal.version.clone(),
        dialect: manifest.journal.dialect.clone(),
        entries: manifest
            .journal
            .entries
            .iter()
            .enumerate()
            .filter_map(|(index, journal_entry)| {
                manifest
                    .entries
                    .get(index)
                    .map(|entry| CanonicalJournalEntryProjection {
                        idx: journal_entry.idx,
                        version: journal_entry.version.clone(),
                        when: journal_entry.when,
                        tag: journal_entry.tag.clone(),
                        breakpoints: journal_entry.breakpoints,
                        sql_fingerprint: entry.sha256.clone(),
                    })
            })
            .collect(),
        sql_files: {
            let mut sql_files = manifest
                .entries
                .iter()
                .map(|entry| CanonicalSqlFileProjection {
                    file_name: entry.file_name.clone(),
                    fingerprint: entry.sha256.clone(),
                })
                .collect::<Vec<_>>();
            sql_files.sort_by(|left, right| left.file_name.cmp(&right.file_name));
            sql_files
        },
    };
    ManifestProjection {
        version: manifest.version,
        fingerprint: manifest.fingerprint.clone(),
        canonical,
        entries,
        legacy_tail,
    }
}

fn project_entry(entry: &rudder_migration_core::MigrationEntry) -> OrderedEntryProjection {
    OrderedEntryProjection {
        order: entry.order,
        file_name: entry.file_name.clone(),
        sha256: entry.sha256.clone(),
        byte_size: entry.byte_size,
        journal_entry: entry.journal_entry.as_ref().map(project_journal_entry),
    }
}

fn project_journal_entry(entry: &JournalEntry) -> JournalEntryProjection {
    JournalEntryProjection {
        idx: entry.idx,
        version: entry.version.clone(),
        when: entry.when,
        tag: entry.tag.clone(),
        breakpoints: entry.breakpoints,
    }
}

fn classify_source_error(code: &str) -> &'static str {
    match code {
        "migration_symlink_rejected" => "symlink",
        "migration_sql_not_regular" | "migration_file_not_regular" => "non_regular",
        "migration_sql_unknown" => "unknown",
        "migration_journal_size_limit"
        | "migration_sql_size_limit"
        | "migration_sql_total_size_limit" => "size_limit",
        "migration_journal_outside_root" => "outside_root",
        _ => "source",
    }
}

fn emit_protocol_error(error: RequestError) {
    let response = DifferentialResponse {
        schema: SCHEMA,
        protocol_version: PROTOCOL_VERSION,
        status: "protocol_error",
        baseline: None,
        candidate: None,
        compatibility: None,
        error: Some(ProtocolError {
            classification: "protocol",
            code: error.code,
            message: error.message,
        }),
    };
    println!(
        "{}",
        serde_json::to_string(&response).expect("protocol error is serializable")
    );
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::{parse_request, SCHEMA};

    #[test]
    fn malformed_json_is_classified_as_protocol_input() {
        let error = parse_request("{not-json").expect_err("malformed input must fail closed");
        assert_eq!(error.code, "invalid_json");
    }

    #[test]
    fn unknown_fields_are_rejected_by_the_versioned_protocol() {
        let input = format!(
            r#"{{
                "schema":"{SCHEMA}",
                "protocolVersion":1,
                "baseline":{{"migrationsDir":"/tmp/migrations","unexpected":true}},
                "candidate":{{"migrationsDir":"/tmp/migrations"}}
            }}"#
        );
        let error = parse_request(&input).expect_err("unknown fields must fail closed");
        assert_eq!(error.code, "invalid_request");
    }

    #[test]
    fn unsupported_schema_and_version_are_rejected() {
        let input = r#"{
            "schema":"other/v1",
            "protocolVersion":1,
            "baseline":{"migrationsDir":"/tmp/migrations"},
            "candidate":{"migrationsDir":"/tmp/migrations"}
        }"#;
        let error = parse_request(input).expect_err("unsupported schema must fail closed");
        assert_eq!(error.code, "unsupported_schema");
    }
}
