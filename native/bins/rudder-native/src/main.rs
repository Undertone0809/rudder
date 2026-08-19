use rudder_archive_core::{
    ArchiveLimits, CREATE_PROTOCOL_VERSION, create_archive, extract_file, inspect_manifest,
};
use rudder_run_evidence_core::{INDEX_PROTOCOL_VERSION, IndexLimits, index_run_log};
use rudder_runtime_payload_core::{
    ArchiveFormat, ExtractLimits, PAYLOAD_PROTOCOL_VERSION, extract_payload, probe_version,
    publish_payload, verify_payload,
};
use rudder_workspace_manifest_core::{
    MANIFEST_PROTOCOL_VERSION, ManifestLimits, ManifestState, watch_workspace,
};
use serde_json::json;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

const CAPABILITIES: &[&str] = &[
    "archive.create",
    "archive.inspectManifest",
    "archive.extractFile",
    "evidence.index",
    "workspace.watch",
    "payload.verify",
    "payload.extract",
    "payload.probeVersion",
    "payload.publish",
];

fn native_target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unsupported"
    }
}

fn required(
    args: &mut impl Iterator<Item = String>,
    code: &'static str,
) -> Result<String, &'static str> {
    args.next().ok_or(code)
}

fn absolute(value: String) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("absolute_paths_required")
    }
}

fn number(value: String) -> Result<u64, &'static str> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or("invalid_limit")
}

fn nonnegative_number(value: String) -> Result<u64, &'static str> {
    value.parse::<u64>().map_err(|_| "invalid_limit")
}

fn capability_for_args(namespace: Option<&str>, operation: Option<&str>) -> Option<&'static str> {
    match (namespace, operation) {
        (Some("archive"), Some("create")) => Some("archive.create"),
        (Some("archive"), Some("inspect-manifest")) => Some("archive.inspectManifest"),
        (Some("archive"), Some("extract-file")) => Some("archive.extractFile"),
        (Some("evidence"), Some("index")) => Some("evidence.index"),
        (Some("workspace"), Some("watch")) => Some("workspace.watch"),
        (Some("payload"), Some("verify")) => Some("payload.verify"),
        (Some("payload"), Some("extract")) => Some("payload.extract"),
        (Some("payload"), Some("probe-version")) => Some("payload.probeVersion"),
        (Some("payload"), Some("publish")) => Some("payload.publish"),
        _ => None,
    }
}

fn response_metadata(protocol_version: u32, capability: &'static str) -> serde_json::Value {
    json!({
        "capability": capability,
        "protocolVersion": protocol_version,
        "target": native_target(),
        "binaryVersion": env!("CARGO_PKG_VERSION"),
    })
}

fn emit_workspace_state(
    state: ManifestState,
    summary: Option<&rudder_workspace_manifest_core::ManifestSummary>,
) {
    let mut output = io::stdout().lock();
    let envelope = json!({
        "ok": true,
        "capability": "workspace.watch",
        "protocolVersion": MANIFEST_PROTOCOL_VERSION,
        "target": native_target(),
        "binaryVersion": env!("CARGO_PKG_VERSION"),
        "state": state,
        "entryCount": summary.map(|value| value.entry_count),
        "manifestPath": summary.map(|value| value.manifest_path.to_string_lossy().to_string()),
    });
    let _ = writeln!(output, "{envelope}");
    let _ = output.flush();
}

fn run_workspace_watch(
    mut args: impl Iterator<Item = String>,
) -> Result<serde_json::Value, &'static str> {
    let root = absolute(required(&mut args, "root_required")?)?;
    let output = absolute(required(&mut args, "output_required")?)?;
    let max_entries = number(required(&mut args, "max_entries_required")?)?;
    let max_path_bytes = number(required(&mut args, "max_path_bytes_required")?)?;
    let debounce_millis = number(required(&mut args, "debounce_millis_required")?)?;
    if debounce_millis > 60_000 || args.next().is_some() {
        return Err("invalid_debounce");
    }
    let (stop_sender, stop_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        let mut buffer = [0_u8; 4096];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    let _ = stop_sender.send(());
                    break;
                }
                Ok(_) => {}
            }
        }
    });
    watch_workspace(
        &root,
        &output,
        ManifestLimits {
            max_entries,
            max_path_bytes,
        },
        Duration::from_millis(debounce_millis),
        stop_receiver,
        emit_workspace_state,
    )
    .map_err(|error| error.code())?;
    Ok(json!({
        "ok": true,
        "capability": "workspace.watch",
        "protocolVersion": MANIFEST_PROTOCOL_VERSION,
        "target": native_target(),
        "binaryVersion": env!("CARGO_PKG_VERSION"),
        "state": "stopped",
    }))
}

struct NativeFailure {
    code: &'static str,
    accepted: bool,
}

impl From<&'static str> for NativeFailure {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            accepted: false,
        }
    }
}

fn run() -> Result<serde_json::Value, NativeFailure> {
    let mut args = std::env::args().skip(1);
    let namespace = args.next();
    let operation = args.next();
    if !matches!(
        namespace.as_deref(),
        Some("archive") | Some("evidence") | Some("workspace") | Some("payload")
    ) {
        return Err("usage".into());
    }
    match (namespace.as_deref(), operation.as_deref()) {
        (Some("archive"), Some("capabilities")) => {
            if args.next().is_some() {
                return Err("usage".into());
            }
            Ok(json!({
                "ok": true,
                "operation": "capabilities",
                "protocolVersion": CREATE_PROTOCOL_VERSION,
                "target": native_target(),
                "effectiveEngine": "rust",
                "capabilities": CAPABILITIES,
                "binaryVersion": env!("CARGO_PKG_VERSION")
            }))
        }
        (Some("workspace"), Some("capabilities")) => {
            if args.next().is_some() {
                return Err("usage".into());
            }
            Ok(json!({
                "ok": true,
                "operation": "capabilities",
                "protocolVersion": MANIFEST_PROTOCOL_VERSION,
                "target": native_target(),
                "effectiveEngine": "rust",
                "capabilities": CAPABILITIES,
                "binaryVersion": env!("CARGO_PKG_VERSION")
            }))
        }
        (Some("workspace"), Some("watch")) => run_workspace_watch(args).map_err(Into::into),
        (Some("archive"), Some("create")) => {
            let plan = absolute(required(&mut args, "plan_required")?)?;
            let output = absolute(required(&mut args, "output_required")?)?;
            let max_archive_bytes = number(required(&mut args, "max_archive_bytes_required")?)?;
            let max_file_bytes = number(required(&mut args, "max_file_bytes_required")?)?;
            let max_total_file_bytes =
                number(required(&mut args, "max_total_file_bytes_required")?)?;
            if args.next().is_some() {
                return Err("usage".into());
            }
            let result = create_archive(
                &plan,
                &output,
                max_archive_bytes,
                max_file_bytes,
                max_total_file_bytes,
            )
            .map_err(|error| error.code())?;
            Ok(json!({
                "ok": true,
                "operation": "create",
                "protocolVersion": CREATE_PROTOCOL_VERSION,
                "byteSize": result.byte_size,
                "sha256": result.sha256,
                "manifestSha256": result.manifest_sha256,
                "treeSha256": result.tree_sha256,
                "entryCount": result.entry_count
            }))
        }
        (Some("archive"), Some("inspect-manifest")) => {
            let input = absolute(required(&mut args, "input_required")?)?;
            let max_archive_bytes = number(required(&mut args, "max_archive_bytes_required")?)?;
            let max_manifest_bytes = number(required(&mut args, "max_manifest_bytes_required")?)?;
            if args.next().is_some() {
                return Err("usage".into());
            }
            let result = inspect_manifest(
                &input,
                ArchiveLimits {
                    max_archive_bytes,
                    max_manifest_bytes,
                },
            )
            .map_err(|error| error.code())?;
            Ok(
                json!({ "ok": true, "operation": "inspectManifest", "protocolVersion": CREATE_PROTOCOL_VERSION, "manifestBase64": result.manifest_base64, "byteSize": result.byte_size, "sha256": result.sha256, "entryCount": result.entry_count }),
            )
        }
        (Some("archive"), Some("extract-file")) => {
            let input = absolute(required(&mut args, "input_required")?)?;
            let entry = required(&mut args, "entry_required")?;
            let output = absolute(required(&mut args, "output_required")?)?;
            let max_archive_bytes = number(required(&mut args, "max_archive_bytes_required")?)?;
            let max_file_bytes = number(required(&mut args, "max_file_bytes_required")?)?;
            if args.next().is_some() {
                return Err("usage".into());
            }
            let result = extract_file(&input, &entry, &output, max_archive_bytes, max_file_bytes)
                .map_err(|error| error.code())?;
            Ok(
                json!({ "ok": true, "operation": "extractFile", "protocolVersion": CREATE_PROTOCOL_VERSION, "accepted": true, "byteSize": result.byte_size, "sha256": result.sha256 }),
            )
        }
        (Some("evidence"), Some("index")) => {
            let input = absolute(required(&mut args, "input_required")?)?;
            let output = absolute(required(&mut args, "output_required")?)?;
            let max_record_bytes = number(required(&mut args, "max_record_bytes_required")?)?;
            let max_records = number(required(&mut args, "max_records_required")?)?;
            if args.next().is_some() {
                return Err("usage".into());
            }
            let result = index_run_log(
                &input,
                &output,
                IndexLimits {
                    max_record_bytes,
                    max_records,
                },
            )
            .map_err(|_| "evidence_index_failed")?;
            Ok(json!({
                "ok": true,
                "operation": "indexEvidence",
                "protocolVersion": INDEX_PROTOCOL_VERSION,
                "sourceBytes": result.source_bytes,
                "recordCount": result.record_count,
                "sourceSha256": result.source_sha256,
                "indexPath": result.index_path,
            }))
        }
        (Some("payload"), Some("capabilities")) => {
            if args.next().is_some() {
                return Err("usage".into());
            }
            Ok(json!({
                "ok": true,
                "operation": "capabilities",
                "protocolVersion": PAYLOAD_PROTOCOL_VERSION,
                "target": native_target(),
                "binaryVersion": env!("CARGO_PKG_VERSION"),
                "effectiveEngine": "rust",
                "capabilities": [
                    "payload.verify",
                    "payload.extract",
                    "payload.probeVersion",
                    "payload.publish"
                ]
            }))
        }
        (Some("payload"), Some("verify")) => {
            let archive = absolute(required(&mut args, "archive_required")?)?;
            let expected_sha256 = required(&mut args, "expected_sha256_required")?;
            let max_archive_bytes = number(required(&mut args, "max_archive_bytes_required")?)?;
            if args.next().is_some() {
                return Err("usage".into());
            }
            let result =
                verify_payload(&archive, &expected_sha256, max_archive_bytes).map_err(|error| {
                    NativeFailure {
                        code: error.code(),
                        accepted: error.accepted_operation(),
                    }
                })?;
            let mut response = response_metadata(PAYLOAD_PROTOCOL_VERSION, "payload.verify");
            response["ok"] = json!(true);
            response["operation"] = json!("verify");
            response["accepted"] = json!(false);
            response["byteSize"] = json!(result.byte_size);
            response["sha256"] = json!(result.sha256);
            Ok(response)
        }
        (Some("payload"), Some("extract")) => {
            let archive = absolute(required(&mut args, "archive_required")?)?;
            let format = ArchiveFormat::parse(&required(&mut args, "format_required")?).map_err(
                |error| NativeFailure {
                    code: error.code(),
                    accepted: error.accepted_operation(),
                },
            )?;
            let staging = absolute(required(&mut args, "staging_required")?)?;
            let max_archive_bytes = number(required(&mut args, "max_archive_bytes_required")?)?;
            let max_entry_bytes = number(required(&mut args, "max_entry_bytes_required")?)?;
            let max_total_bytes = number(required(&mut args, "max_total_bytes_required")?)?;
            let strip_components =
                nonnegative_number(required(&mut args, "strip_components_required")?)?;
            if args.next().is_some() || strip_components > usize::MAX as u64 {
                return Err("usage".into());
            }
            let result = extract_payload(
                &archive,
                format,
                &staging,
                ExtractLimits {
                    max_archive_bytes,
                    max_entry_bytes,
                    max_total_bytes,
                    strip_components: strip_components as usize,
                },
            )
            .map_err(|error| NativeFailure {
                code: error.code(),
                accepted: error.accepted_operation(),
            })?;
            let mut response = response_metadata(PAYLOAD_PROTOCOL_VERSION, "payload.extract");
            response["ok"] = json!(true);
            response["operation"] = json!("extract");
            response["accepted"] = json!(true);
            response["entryCount"] = json!(result.entry_count);
            response["totalBytes"] = json!(result.total_bytes);
            response["stagingPath"] = json!(result.staging_path);
            Ok(response)
        }
        (Some("payload"), Some("probe-version")) => {
            let root = absolute(required(&mut args, "root_required")?)?;
            let executable = PathBuf::from(required(&mut args, "executable_required")?);
            let expected_fragment = required(&mut args, "expected_version_required")?;
            if args.next().is_some() {
                return Err("usage".into());
            }
            let result =
                probe_version(&root, &executable, &expected_fragment).map_err(|error| {
                    NativeFailure {
                        code: error.code(),
                        accepted: error.accepted_operation(),
                    }
                })?;
            let mut response = response_metadata(PAYLOAD_PROTOCOL_VERSION, "payload.probeVersion");
            response["ok"] = json!(true);
            response["operation"] = json!("probeVersion");
            response["accepted"] = json!(true);
            response["versionOutput"] = json!(result.version_output);
            Ok(response)
        }
        (Some("payload"), Some("publish")) => {
            let staging = absolute(required(&mut args, "staging_required")?)?;
            let destination = absolute(required(&mut args, "destination_required")?)?;
            if args.next().is_some() {
                return Err("usage".into());
            }
            let result =
                publish_payload(&staging, &destination).map_err(|error| NativeFailure {
                    code: error.code(),
                    accepted: error.accepted_operation(),
                })?;
            let mut response = response_metadata(PAYLOAD_PROTOCOL_VERSION, "payload.publish");
            response["ok"] = json!(true);
            response["operation"] = json!("publish");
            response["accepted"] = json!(true);
            response["destinationPath"] = json!(result.destination_path);
            response["recoveredPrevious"] = json!(result.recovered_previous);
            response["alreadyPublished"] = json!(result.already_published);
            Ok(response)
        }
        _ => Err("usage".into()),
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
        Err(failure) => {
            let args = std::env::args().skip(1).collect::<Vec<_>>();
            let capability = capability_for_args(
                args.first().map(String::as_str),
                args.get(1).map(String::as_str),
            );
            let mut response = response_metadata(
                if capability.is_some_and(|value| value.starts_with("payload.")) {
                    PAYLOAD_PROTOCOL_VERSION
                } else {
                    CREATE_PROTOCOL_VERSION
                },
                capability.unwrap_or("rudder-native"),
            );
            response["ok"] = json!(false);
            response["errorCode"] = json!(failure.code);
            response["accepted"] = json!(failure.accepted);
            println!("{response}");
            eprintln!("rudder-native: operation failed");
            std::process::exit(2);
        }
    }
}
