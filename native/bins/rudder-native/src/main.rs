use rudder_archive_core::{
    ArchiveLimits, CREATE_PROTOCOL_VERSION, create_archive, extract_file, inspect_manifest,
};
use serde_json::json;
use std::path::PathBuf;

const CAPABILITIES: &[&str] = &[
    "archive.create",
    "archive.inspectManifest",
    "archive.extractFile",
];

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

fn run() -> Result<serde_json::Value, &'static str> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("archive") {
        return Err("usage");
    }
    match args.next().as_deref() {
        Some("capabilities") => {
            if args.next().is_some() {
                return Err("usage");
            }
            Ok(json!({
                "ok": true,
                "operation": "capabilities",
                "protocolVersion": CREATE_PROTOCOL_VERSION,
                "capabilities": CAPABILITIES
            }))
        }
        Some("create") => {
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
        Some("inspect-manifest") => {
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
        Some("extract-file") => {
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
                json!({ "ok": true, "operation": "extractFile", "protocolVersion": CREATE_PROTOCOL_VERSION, "byteSize": result.byte_size, "sha256": result.sha256 }),
            )
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
