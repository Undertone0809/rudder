use rudder_archive_core::{
    ArchiveLimits, CREATE_PROTOCOL_VERSION, create_archive, extract_file, inspect_manifest,
};
use rudder_run_evidence_core::{INDEX_PROTOCOL_VERSION, IndexLimits, index_run_log};
use rudder_runtime_payload_core::{
    ArchiveFormat, ExtractLimits, PAYLOAD_PROTOCOL_VERSION, PayloadError, extract_payload,
    probe_version, publish_payload, verify_payload,
};
use rudder_workspace_manifest_core::{
    MANIFEST_PROTOCOL_VERSION, ManifestError, ManifestLimits, build_manifest, watch_workspace,
};
use serde_json::{Value, json};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

const CAPABILITIES: &[&str] = &[
    "archive.create",
    "archive.inspectManifest",
    "archive.extractFile",
    "evidence.index",
    "payload.verify",
    "payload.extract",
    "payload.probeVersion",
    "payload.publish",
    "workspace.manifest",
    "workspace.watch",
];

#[derive(Debug)]
struct CliError {
    code: &'static str,
    capability: &'static str,
    accepted: bool,
}

impl CliError {
    fn safe(code: &'static str, capability: &'static str) -> Self {
        Self {
            code,
            capability,
            accepted: false,
        }
    }

    fn from_payload(error: PayloadError, capability: &'static str) -> Self {
        Self {
            code: error.code(),
            capability,
            accepted: error.accepted_operation(),
        }
    }

    fn from_manifest(error: ManifestError, capability: &'static str) -> Self {
        Self {
            code: error.code(),
            capability,
            accepted: error.accepted_operation(),
        }
    }
}

fn required(
    args: &mut impl Iterator<Item = String>,
    code: &'static str,
    capability: &'static str,
) -> Result<String, CliError> {
    args.next().ok_or_else(|| CliError::safe(code, capability))
}

fn absolute(value: String, capability: &'static str) -> Result<PathBuf, CliError> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(CliError::safe("absolute_paths_required", capability))
    }
}

fn number(value: String, capability: &'static str) -> Result<u64, CliError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| CliError::safe("invalid_limit", capability))
}

fn usize_number(value: String, capability: &'static str) -> Result<usize, CliError> {
    value
        .parse::<usize>()
        .map_err(|_| CliError::safe("invalid_limit", capability))
}

fn target() -> String {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin".into()
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin".into()
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc".into()
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu".into()
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu".into()
    } else {
        format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
    }
}

fn envelope(
    mut value: Value,
    capability: &'static str,
    protocol_version: u32,
    accepted: bool,
) -> Value {
    let object = value
        .as_object_mut()
        .expect("rudder-native command responses are objects");
    object.insert("capability".into(), json!(capability));
    object.insert("target".into(), json!(target()));
    object.insert("binaryVersion".into(), json!(env!("CARGO_PKG_VERSION")));
    object.insert("protocolVersion".into(), json!(protocol_version));
    object.insert("effectiveEngine".into(), json!("rust"));
    object.insert("accepted".into(), json!(accepted));
    object.insert("fallbackSafe".into(), json!(!accepted));
    value
}

fn ensure_finished(
    args: &mut impl Iterator<Item = String>,
    capability: &'static str,
) -> Result<(), CliError> {
    if args.next().is_some() {
        Err(CliError::safe("usage", capability))
    } else {
        Ok(())
    }
}

fn emit(value: &Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn run_workspace_watch(
    root: PathBuf,
    output: PathBuf,
    limits: ManifestLimits,
    debounce_ms: u64,
) -> Result<Value, CliError> {
    const CAPABILITY: &str = "workspace.watch";
    let (stop_sender, stop_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut buffer = [0_u8; 1024];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let _ = stop_sender.send(());
    });
    watch_workspace(
        &root,
        &output,
        limits,
        Duration::from_millis(debounce_ms),
        stop_receiver,
        |state, summary| {
            let value = envelope(
                json!({
                    "ok": true,
                    "operation": "watchWorkspace",
                    "state": state,
                    "entryCount": summary.map(|value| value.entry_count),
                    "manifestPath": summary.map(|value| &value.manifest_path),
                }),
                CAPABILITY,
                MANIFEST_PROTOCOL_VERSION,
                true,
            );
            let _ = emit(&value);
        },
    )
    .map_err(|error| CliError::from_manifest(error, CAPABILITY))?;
    Ok(envelope(
        json!({ "ok": true, "operation": "watchWorkspace", "state": "stopped" }),
        CAPABILITY,
        MANIFEST_PROTOCOL_VERSION,
        true,
    ))
}

fn run() -> Result<Value, CliError> {
    let mut args = std::env::args().skip(1);
    let namespace = args.next();
    let operation = args.next();
    match (namespace.as_deref(), operation.as_deref()) {
        (Some("archive"), Some("capabilities"))
        | (Some("payload"), Some("capabilities"))
        | (Some("workspace"), Some("capabilities")) => {
            ensure_finished(&mut args, "rudder-native.capabilities")?;
            Ok(envelope(
                json!({
                    "ok": true,
                    "operation": "capabilities",
                    "capabilities": CAPABILITIES
                }),
                "rudder-native.capabilities",
                CREATE_PROTOCOL_VERSION,
                false,
            ))
        }
        (Some("archive"), Some("create")) => {
            const CAPABILITY: &str = "archive.create";
            let plan = absolute(
                required(&mut args, "plan_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let output = absolute(
                required(&mut args, "output_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_archive_bytes = number(
                required(&mut args, "max_archive_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_file_bytes = number(
                required(&mut args, "max_file_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_total_file_bytes = number(
                required(&mut args, "max_total_file_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            ensure_finished(&mut args, CAPABILITY)?;
            let result = create_archive(
                &plan,
                &output,
                max_archive_bytes,
                max_file_bytes,
                max_total_file_bytes,
            )
            .map_err(|error| CliError::safe(error.code(), CAPABILITY))?;
            Ok(envelope(
                json!({
                    "ok": true,
                    "operation": "create",
                    "byteSize": result.byte_size,
                    "sha256": result.sha256,
                    "manifestSha256": result.manifest_sha256,
                    "treeSha256": result.tree_sha256,
                    "entryCount": result.entry_count
                }),
                CAPABILITY,
                CREATE_PROTOCOL_VERSION,
                true,
            ))
        }
        (Some("archive"), Some("inspect-manifest")) => {
            const CAPABILITY: &str = "archive.inspectManifest";
            let input = absolute(
                required(&mut args, "input_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_archive_bytes = number(
                required(&mut args, "max_archive_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_manifest_bytes = number(
                required(&mut args, "max_manifest_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            ensure_finished(&mut args, CAPABILITY)?;
            let result = inspect_manifest(
                &input,
                ArchiveLimits {
                    max_archive_bytes,
                    max_manifest_bytes,
                },
            )
            .map_err(|error| CliError::safe(error.code(), CAPABILITY))?;
            Ok(envelope(
                json!({ "ok": true, "operation": "inspectManifest", "manifestBase64": result.manifest_base64, "byteSize": result.byte_size, "sha256": result.sha256, "entryCount": result.entry_count }),
                CAPABILITY,
                CREATE_PROTOCOL_VERSION,
                false,
            ))
        }
        (Some("archive"), Some("extract-file")) => {
            const CAPABILITY: &str = "archive.extractFile";
            let input = absolute(
                required(&mut args, "input_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let entry = required(&mut args, "entry_required", CAPABILITY)?;
            let output = absolute(
                required(&mut args, "output_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_archive_bytes = number(
                required(&mut args, "max_archive_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_file_bytes = number(
                required(&mut args, "max_file_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            ensure_finished(&mut args, CAPABILITY)?;
            let result = extract_file(&input, &entry, &output, max_archive_bytes, max_file_bytes)
                .map_err(|error| CliError::safe(error.code(), CAPABILITY))?;
            Ok(envelope(
                json!({ "ok": true, "operation": "extractFile", "byteSize": result.byte_size, "sha256": result.sha256 }),
                CAPABILITY,
                CREATE_PROTOCOL_VERSION,
                true,
            ))
        }
        (Some("evidence"), Some("index")) => {
            const CAPABILITY: &str = "evidence.index";
            let input = absolute(
                required(&mut args, "input_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let output = absolute(
                required(&mut args, "output_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_record_bytes = number(
                required(&mut args, "max_record_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let max_records = number(
                required(&mut args, "max_records_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            ensure_finished(&mut args, CAPABILITY)?;
            let result = index_run_log(
                &input,
                &output,
                IndexLimits {
                    max_record_bytes,
                    max_records,
                },
            )
            .map_err(|_| CliError::safe("evidence_index_failed", CAPABILITY))?;
            Ok(envelope(
                json!({
                    "ok": true,
                    "operation": "indexEvidence",
                    "sourceBytes": result.source_bytes,
                    "recordCount": result.record_count,
                    "sourceSha256": result.source_sha256,
                    "indexPath": result.index_path,
                }),
                CAPABILITY,
                INDEX_PROTOCOL_VERSION,
                true,
            ))
        }
        (Some("payload"), Some("verify")) => {
            const CAPABILITY: &str = "payload.verify";
            let archive = absolute(
                required(&mut args, "archive_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let expected_sha256 = required(&mut args, "expected_sha256_required", CAPABILITY)?;
            let max_archive_bytes = number(
                required(&mut args, "max_archive_bytes_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            ensure_finished(&mut args, CAPABILITY)?;
            let result = verify_payload(&archive, &expected_sha256, max_archive_bytes)
                .map_err(|error| CliError::from_payload(error, CAPABILITY))?;
            Ok(envelope(
                json!({ "ok": true, "operation": "verifyPayload", "byteSize": result.byte_size, "sha256": result.sha256 }),
                CAPABILITY,
                PAYLOAD_PROTOCOL_VERSION,
                false,
            ))
        }
        (Some("payload"), Some("extract")) => {
            const CAPABILITY: &str = "payload.extract";
            let archive = absolute(
                required(&mut args, "archive_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let format = ArchiveFormat::parse(&required(&mut args, "format_required", CAPABILITY)?)
                .map_err(|error| CliError::from_payload(error, CAPABILITY))?;
            let staging = absolute(
                required(&mut args, "staging_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let limits = ExtractLimits {
                max_archive_bytes: number(
                    required(&mut args, "max_archive_bytes_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
                max_entry_bytes: number(
                    required(&mut args, "max_entry_bytes_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
                max_total_bytes: number(
                    required(&mut args, "max_total_bytes_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
                strip_components: usize_number(
                    required(&mut args, "strip_components_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
            };
            ensure_finished(&mut args, CAPABILITY)?;
            let result = extract_payload(&archive, format, &staging, limits)
                .map_err(|error| CliError::from_payload(error, CAPABILITY))?;
            Ok(envelope(
                json!({ "ok": true, "operation": "extractPayload", "entryCount": result.entry_count, "totalBytes": result.total_bytes, "stagingPath": result.staging_path }),
                CAPABILITY,
                PAYLOAD_PROTOCOL_VERSION,
                true,
            ))
        }
        (Some("payload"), Some("probe-version")) => {
            const CAPABILITY: &str = "payload.probeVersion";
            let root = absolute(
                required(&mut args, "root_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let executable = PathBuf::from(required(&mut args, "executable_required", CAPABILITY)?);
            let expected = required(&mut args, "expected_version_required", CAPABILITY)?;
            ensure_finished(&mut args, CAPABILITY)?;
            let result = probe_version(&root, &executable, &expected)
                .map_err(|error| CliError::from_payload(error, CAPABILITY))?;
            Ok(envelope(
                json!({ "ok": true, "operation": "probePayloadVersion", "versionOutput": result.version_output }),
                CAPABILITY,
                PAYLOAD_PROTOCOL_VERSION,
                true,
            ))
        }
        (Some("payload"), Some("publish")) => {
            const CAPABILITY: &str = "payload.publish";
            let staging = absolute(
                required(&mut args, "staging_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let destination = absolute(
                required(&mut args, "destination_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            ensure_finished(&mut args, CAPABILITY)?;
            let result = publish_payload(&staging, &destination)
                .map_err(|error| CliError::from_payload(error, CAPABILITY))?;
            Ok(envelope(
                json!({ "ok": true, "operation": "publishPayload", "destinationPath": result.destination_path, "recoveredPrevious": result.recovered_previous, "alreadyPublished": result.already_published }),
                CAPABILITY,
                PAYLOAD_PROTOCOL_VERSION,
                true,
            ))
        }
        (Some("workspace"), Some("manifest")) => {
            const CAPABILITY: &str = "workspace.manifest";
            let root = absolute(
                required(&mut args, "root_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let output = absolute(
                required(&mut args, "output_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let limits = ManifestLimits {
                max_entries: number(
                    required(&mut args, "max_entries_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
                max_path_bytes: number(
                    required(&mut args, "max_path_bytes_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
            };
            ensure_finished(&mut args, CAPABILITY)?;
            let result = build_manifest(&root, &output, limits)
                .map_err(|error| CliError::from_manifest(error, CAPABILITY))?;
            Ok(envelope(
                json!({ "ok": true, "operation": "buildWorkspaceManifest", "state": result.state, "entryCount": result.entry_count, "manifestPath": result.manifest_path }),
                CAPABILITY,
                MANIFEST_PROTOCOL_VERSION,
                true,
            ))
        }
        (Some("workspace"), Some("watch")) => {
            const CAPABILITY: &str = "workspace.watch";
            let root = absolute(
                required(&mut args, "root_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let output = absolute(
                required(&mut args, "output_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            let limits = ManifestLimits {
                max_entries: number(
                    required(&mut args, "max_entries_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
                max_path_bytes: number(
                    required(&mut args, "max_path_bytes_required", CAPABILITY)?,
                    CAPABILITY,
                )?,
            };
            let debounce_ms = number(
                required(&mut args, "debounce_ms_required", CAPABILITY)?,
                CAPABILITY,
            )?;
            ensure_finished(&mut args, CAPABILITY)?;
            run_workspace_watch(root, output, limits, debounce_ms)
        }
        _ => Err(CliError::safe("usage", "rudder-native")),
    }
}

fn handle_metadata_args() -> bool {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("rudder-native {}", env!("CARGO_PKG_VERSION"));
            true
        }
        Some("--protocol-version") => {
            println!("{CREATE_PROTOCOL_VERSION}");
            true
        }
        Some("--capabilities") => {
            println!(
                "{}",
                serde_json::to_string(CAPABILITIES).expect("static capabilities serialize")
            );
            true
        }
        _ => false,
    }
}

fn main() {
    if handle_metadata_args() {
        return;
    }
    match run() {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!(
                "{}",
                envelope(
                    json!({ "ok": false, "errorCode": error.code }),
                    error.capability,
                    CREATE_PROTOCOL_VERSION,
                    error.accepted,
                )
            );
            eprintln!("rudder-native: {} failed", error.capability);
            std::process::exit(2);
        }
    }
}
