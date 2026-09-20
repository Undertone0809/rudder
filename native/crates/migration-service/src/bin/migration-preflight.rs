use rudder_migration_core::{
    MigrationInspectionOptions, MigrationManifestOptions, MigrationSource, inspect_migration_source,
};
use rudder_migration_service::{
    MigrationPreflightReport, MigrationPreflightService, MigrationPreflightStatus,
};
use serde::{Deserialize, Serialize};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::env;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

const SCHEMA: &str = "rudder.migration-preflight/v1";
const PROTOCOL_VERSION: u8 = 1;
const DATABASE_URL_ENV: &str = "RUDDER_MIGRATION_PREFLIGHT_DATABASE_URL";
const MAX_INPUT_BYTES: usize = 256 * 1024;
const MAX_DATABASE_URL_BYTES: usize = 8 * 1024;
const DATABASE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const APPLICATION_NAME: &str = "rudder-migration-preflight";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PreflightRequest {
    schema: String,
    protocol_version: u8,
    source: SourceSpec,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceSpec {
    migrations_dir: String,
    journal_file: Option<String>,
    expected_fingerprint: Option<String>,
}

impl SourceSpec {
    fn source(&self) -> Result<MigrationSource, CliError> {
        let migrations_dir = absolute_source_path(&self.migrations_dir)?;
        let source = match self.journal_file.as_deref() {
            Some(journal_file) => MigrationSource::with_journal_path(
                migrations_dir,
                absolute_source_path(journal_file)?,
            ),
            None => MigrationSource::new(migrations_dir),
        };
        Ok(source)
    }
}

#[derive(Clone, Copy, Debug)]
struct CliError {
    classification: &'static str,
    code: &'static str,
    message: &'static str,
}

impl CliError {
    const fn new(classification: &'static str, code: &'static str, message: &'static str) -> Self {
        Self {
            classification,
            code,
            message,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    classification: &'static str,
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightResponse {
    schema: &'static str,
    protocol_version: u8,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<MigrationPreflightReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorResponse>,
}

#[tokio::main]
async fn main() {
    let response = match run().await {
        Ok(report) => success_response(report),
        Err(error) => error_response(error),
    };
    let failed = response.status == "error";
    println!(
        "{}",
        serde_json::to_string(&response).expect("preflight response is serializable")
    );
    if failed {
        std::process::exit(2);
    }
}

async fn run() -> Result<MigrationPreflightReport, CliError> {
    let input = read_bounded_stdin()?;
    let request = parse_request(&input)?;
    let source = request.source.source()?;
    let manifest = inspect_migration_source(
        &source,
        &MigrationInspectionOptions {
            manifest: MigrationManifestOptions::default(),
            expected_fingerprint: request.source.expected_fingerprint,
        },
    )
    .map_err(|error| CliError::new("source", error.code(), "migration source inspection failed"))?;
    if !manifest.validate_integrity().valid {
        return Err(CliError::new(
            "source",
            "migration_manifest_invalid",
            "migration source inspection failed",
        ));
    }

    let database_url = database_url_from_env()?;
    let connect_options = PgConnectOptions::from_str(&database_url)
        .map(|options| options.application_name(APPLICATION_NAME))
        .map_err(|_| {
            CliError::new(
                "configuration",
                "database_url_invalid",
                "database URL is invalid",
            )
        })?;
    let pool = tokio::time::timeout(
        DATABASE_CONNECT_TIMEOUT,
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(DATABASE_CONNECT_TIMEOUT)
            .connect_with(connect_options),
    )
    .await
    .map_err(|_| {
        CliError::new(
            "database",
            "database_connect_failed",
            "database connection failed",
        )
    })?
    .map_err(|_| {
        CliError::new(
            "database",
            "database_connect_failed",
            "database connection failed",
        )
    })?;
    let service = MigrationPreflightService::new(pool.clone());
    let result = service.preflight(&manifest).await.map_err(|_| {
        CliError::new(
            "database",
            "database_preflight_failed",
            "database preflight failed",
        )
    });
    pool.close().await;
    result
}

fn read_bounded_stdin() -> Result<Vec<u8>, CliError> {
    let stdin = io::stdin();
    let mut reader = stdin.lock().take((MAX_INPUT_BYTES + 1) as u64);
    let mut input = Vec::new();
    reader.read_to_end(&mut input).map_err(|_| {
        CliError::new(
            "protocol",
            "stdin_read_failed",
            "could not read protocol input",
        )
    })?;
    if input.len() > MAX_INPUT_BYTES {
        return Err(CliError::new(
            "protocol",
            "input_too_large",
            "protocol input exceeds the size limit",
        ));
    }
    Ok(input)
}

fn parse_request(input: &[u8]) -> Result<PreflightRequest, CliError> {
    let request = serde_json::from_slice::<PreflightRequest>(input).map_err(|error| {
        let code = if error.is_syntax() || error.is_eof() {
            "invalid_json"
        } else {
            "invalid_request"
        };
        CliError::new("protocol", code, "protocol input is invalid")
    })?;
    if request.schema != SCHEMA {
        return Err(CliError::new(
            "protocol",
            "unsupported_schema",
            "protocol schema is unsupported",
        ));
    }
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(CliError::new(
            "protocol",
            "unsupported_protocol_version",
            "protocol version is unsupported",
        ));
    }
    Ok(request)
}

fn absolute_source_path(value: &str) -> Result<PathBuf, CliError> {
    let path = Path::new(value);
    if value.is_empty()
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(CliError::new(
            "protocol",
            "source_path_invalid",
            "source paths must be absolute and normalized",
        ));
    }
    Ok(path.to_path_buf())
}

fn database_url_from_env() -> Result<String, CliError> {
    let value = env::var(DATABASE_URL_ENV).map_err(|_| {
        CliError::new(
            "configuration",
            "database_url_missing",
            "required database environment variable is missing",
        )
    })?;
    if value.is_empty() {
        return Err(CliError::new(
            "configuration",
            "database_url_missing",
            "required database environment variable is missing",
        ));
    }
    if value.len() > MAX_DATABASE_URL_BYTES {
        return Err(CliError::new(
            "configuration",
            "database_url_too_large",
            "database URL exceeds the size limit",
        ));
    }
    if !value.starts_with("postgres://") && !value.starts_with("postgresql://") {
        return Err(CliError::new(
            "configuration",
            "database_url_protocol_unsupported",
            "database URL protocol is unsupported",
        ));
    }
    Ok(value)
}

fn success_response(report: MigrationPreflightReport) -> PreflightResponse {
    let status = status_name(report.status);
    PreflightResponse {
        schema: SCHEMA,
        protocol_version: PROTOCOL_VERSION,
        status,
        report: Some(report),
        error: None,
    }
}

fn error_response(error: CliError) -> PreflightResponse {
    PreflightResponse {
        schema: SCHEMA,
        protocol_version: PROTOCOL_VERSION,
        status: "error",
        report: None,
        error: Some(ErrorResponse {
            classification: error.classification,
            code: error.code,
            message: error.message,
        }),
    }
}

fn status_name(status: MigrationPreflightStatus) -> &'static str {
    match status {
        MigrationPreflightStatus::Bootstrap => "bootstrap",
        MigrationPreflightStatus::UnsafeLegacy => "unsafe-legacy",
        MigrationPreflightStatus::Pending => "pending",
        MigrationPreflightStatus::Mismatch => "mismatch",
        MigrationPreflightStatus::MissingCoreSchema => "missing-core-schema",
        MigrationPreflightStatus::Current => "current",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rudder_migration_history_core::{
        MigrationHistoryPreflight, MigrationHistoryReason, MigrationHistoryStatus,
    };
    use serde_json::Value;
    use std::io::Cursor;

    fn sample_report(status: MigrationPreflightStatus) -> MigrationPreflightReport {
        MigrationPreflightReport {
            status,
            table_count: 0,
            journal_present: false,
            journal_schema: None,
            core_schema_present: true,
            organizations_table_present: false,
            history: MigrationHistoryPreflight {
                status: MigrationHistoryStatus::NeedsMigrations,
                reason: MigrationHistoryReason::MigrationJournalMissing,
                manifest_fingerprint: "fixture".to_owned(),
                migration_table_schema: None,
                journal_entry_count: 0,
                applied_migrations: Vec::new(),
                pending_migrations: Vec::new(),
                diagnostics: Vec::new(),
            },
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn malformed_json_is_rejected_without_details() {
        let error = parse_request(b"{not-json").expect_err("malformed JSON must fail closed");
        assert_eq!(error.code, "invalid_json");
        let output = serde_json::to_string(&error_response(error)).unwrap();
        assert!(!output.contains("not-json"));
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let input = format!(
            r#"{{"schema":"{SCHEMA}","protocolVersion":1,"source":{{"migrationsDir":"/tmp/migrations","unexpected":"secret"}}}}"#
        );
        let error = parse_request(input.as_bytes()).expect_err("unknown fields must fail closed");
        assert_eq!(error.code, "invalid_request");
        let output = serde_json::to_string(&error_response(error)).unwrap();
        assert!(!output.contains("secret"));
    }

    #[test]
    fn unknown_protocol_version_is_rejected() {
        let input = format!(
            r#"{{"schema":"{SCHEMA}","protocolVersion":2,"source":{{"migrationsDir":"/tmp/migrations"}}}}"#
        );
        let error = parse_request(input.as_bytes()).expect_err("unknown version must fail closed");
        assert_eq!(error.code, "unsupported_protocol_version");
    }

    #[test]
    fn business_statuses_serialize_as_success_reports() {
        for status in [
            MigrationPreflightStatus::Bootstrap,
            MigrationPreflightStatus::Current,
            MigrationPreflightStatus::Pending,
            MigrationPreflightStatus::Mismatch,
            MigrationPreflightStatus::UnsafeLegacy,
            MigrationPreflightStatus::MissingCoreSchema,
        ] {
            let response = serde_json::to_value(success_response(sample_report(status))).unwrap();
            assert_eq!(
                response["status"],
                Value::String(status_name(status).to_owned())
            );
            assert_eq!(
                response["report"]["status"],
                Value::String(status_name(status).to_owned())
            );
            assert!(response.get("error").is_none());
        }
    }

    #[test]
    fn relative_paths_are_rejected_without_disclosure() {
        let secret = "relative/secret-db-password";
        let input = format!(
            r#"{{"schema":"{SCHEMA}","protocolVersion":1,"source":{{"migrationsDir":"{secret}"}}}}"#
        );
        let request = parse_request(input.as_bytes()).unwrap();
        let error = request
            .source
            .source()
            .expect_err("relative source path must fail closed");
        assert_eq!(error.code, "source_path_invalid");
        let output = serde_json::to_string(&error_response(error)).unwrap();
        assert!(!output.contains(secret));
    }

    #[test]
    fn source_error_does_not_disclose_path() {
        let root = tempfile::tempdir().unwrap();
        let secret_path = root.path().join("db-password=secret").join("migrations");
        let error = inspect_migration_source(
            &MigrationSource::new(&secret_path),
            &MigrationInspectionOptions::default(),
        )
        .expect_err("missing source must fail");
        let output = serde_json::to_string(&error_response(CliError::new(
            "source",
            error.code(),
            "migration source inspection failed",
        )))
        .unwrap();
        assert!(!output.contains(secret_path.to_str().unwrap()));
        assert!(!output.contains("db-password=secret"));
    }

    #[test]
    fn oversized_input_is_rejected_without_disclosure() {
        let secret = b"db-password=secret";
        let mut input = vec![b'x'; MAX_INPUT_BYTES];
        input.extend_from_slice(secret);
        let mut reader = Cursor::new(input);
        let error = {
            let mut bounded = reader.by_ref().take((MAX_INPUT_BYTES + 1) as u64);
            let mut bytes = Vec::new();
            bounded.read_to_end(&mut bytes).unwrap();
            if bytes.len() > MAX_INPUT_BYTES {
                CliError::new(
                    "protocol",
                    "input_too_large",
                    "protocol input exceeds the size limit",
                )
            } else {
                panic!("fixture must exceed input limit");
            }
        };
        let output = serde_json::to_string(&error_response(error)).unwrap();
        assert!(!output.contains(std::str::from_utf8(secret).unwrap()));
    }

    #[test]
    fn unsupported_database_url_protocol_is_generic() {
        let error = CliError::new(
            "configuration",
            "database_url_protocol_unsupported",
            "database URL protocol is unsupported",
        );
        let output = serde_json::to_string(&error_response(error)).unwrap();
        assert!(!output.contains("file://"));
    }
}
