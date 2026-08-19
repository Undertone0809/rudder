use rudder_archive_core::{
    ArchiveLimits, CREATE_PROTOCOL_VERSION, create_archive, extract_file, inspect_manifest,
};
use rudder_run_evidence_core::{INDEX_PROTOCOL_VERSION, IndexLimits, index_run_log};
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

fn run() -> Result<serde_json::Value, &'static str> {
    let mut args = std::env::args().skip(1);
    let namespace = args.next();
    let operation = args.next();
    if !matches!(
        namespace.as_deref(),
        Some("archive") | Some("evidence") | Some("workspace")
    ) {
        return Err("usage");
    }
    match (namespace.as_deref(), operation.as_deref()) {
        (Some("archive"), Some("capabilities")) => {
            if args.next().is_some() {
                return Err("usage");
            }
            Ok(json!({
                "ok": true,
                "operation": "capabilities",
                "protocolVersion": CREATE_PROTOCOL_VERSION,
                "target": native_target(),
                "effectiveEngine": "rust",
                "capabilities": CAPABILITIES
            }))
        }
        (Some("workspace"), Some("capabilities")) => {
            if args.next().is_some() {
                return Err("usage");
            }
            Ok(json!({
                "ok": true,
                "operation": "capabilities",
                "protocolVersion": MANIFEST_PROTOCOL_VERSION,
                "target": native_target(),
                "effectiveEngine": "rust",
                "capabilities": CAPABILITIES
            }))
        }
        (Some("workspace"), Some("watch")) => run_workspace_watch(args),
        (Some("archive"), Some("create")) => {
            let plan = absolute(required(&mut args, "plan_required")?)?;
            let output = absolute(required(&mut args, "output_required")?)?;
            let max_archive_bytes = number(required(&mut args, "max_archive_bytes_required")?)?;
            let max_file_bytes = number(required(&mut args, "max_file_bytes_required")?)?;
            let max_total_file_bytes =
                number(required(&mut args, "max_total_file_bytes_required")?)?;
            if args.next().is_some() {
                return Err("usage");
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
                return Err("usage");
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
                return Err("usage");
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
                return Err("usage");
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
        _ => Err("usage"),
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
        Err(code) => {
            println!(
                "{}",
                json!({ "ok": false, "protocolVersion": CREATE_PROTOCOL_VERSION, "errorCode": code })
            );
            eprintln!("rudder-native: archive operation failed");
            std::process::exit(2);
        }
    }
}
