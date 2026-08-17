use crc32fast::Hasher as Crc32;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::tempdir;

const MANIFEST: &str = ".rudder-backup/manifest-v2.json";

fn fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut local = Vec::new();
    let mut central = Vec::new();
    for (name, body) in entries {
        let name = name.as_bytes();
        let offset = local.len() as u32;
        let mut crc = Crc32::new();
        crc.update(body);
        let checksum = crc.finalize();
        local.extend_from_slice(&0x04034b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes());
        local.extend_from_slice(&0x0800u16.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&[0; 4]);
        local.extend_from_slice(&checksum.to_le_bytes());
        local.extend_from_slice(&(body.len() as u32).to_le_bytes());
        local.extend_from_slice(&(body.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(name);
        local.extend_from_slice(body);
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&[0; 4]);
        central.extend_from_slice(&checksum.to_le_bytes());
        central.extend_from_slice(&(body.len() as u32).to_le_bytes());
        central.extend_from_slice(&(body.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 8]);
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let central_offset = local.len() as u32;
    let mut result = local;
    result.extend_from_slice(&central);
    result.extend_from_slice(&0x06054b50u32.to_le_bytes());
    result.extend_from_slice(&[0; 4]);
    result.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    result.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    result.extend_from_slice(&(central.len() as u32).to_le_bytes());
    result.extend_from_slice(&central_offset.to_le_bytes());
    result.extend_from_slice(&0u16.to_le_bytes());
    result
}

fn run(args: &[&str]) -> (i32, Value, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_rudder-native"))
        .args(args)
        .output()
        .unwrap();
    (
        output.status.code().unwrap(),
        serde_json::from_slice(&output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

fn run_raw(args: &[&str]) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_rudder-native"))
        .args(args)
        .output()
        .unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

fn write_archive(path: &Path, body: &[u8]) {
    fs::write(
        path,
        fixture(&[
            (MANIFEST, br#"{"version":2}"#),
            ("workspace/file.bin", body),
        ]),
    )
    .unwrap();
}

fn selected_body_offset(archive: &[u8], body: &[u8]) -> usize {
    archive
        .windows(body.len())
        .position(|window| window == body)
        .unwrap()
}

fn assert_no_create_artifacts(root: &Path, output: &Path) {
    assert!(!output.exists());
    let output_name = output.file_name().unwrap().to_str().unwrap();
    assert!(fs::read_dir(root).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(&format!(".{output_name}."))
    }));
}

#[test]
fn reports_version_protocol_and_capabilities_metadata() {
    let (code, stdout, stderr) = run_raw(&["--version"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        stdout,
        format!("rudder-native {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert!(stderr.is_empty());

    let (code, stdout, stderr) = run_raw(&["--protocol-version"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout, "1\n");
    assert!(stderr.is_empty());

    let (code, stdout, stderr) = run_raw(&["--capabilities"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap(),
        serde_json::json!([
            "archive.create",
            "archive.inspectManifest",
            "archive.extractFile",
            "evidence.index",
            "payload.verify",
            "payload.extract",
            "payload.probeVersion",
            "payload.publish",
            "workspace.manifest",
            "workspace.watch"
        ])
    );
    assert!(stderr.is_empty());

    let (code, archive_capabilities, stderr) = run(&["archive", "capabilities"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap(),
        archive_capabilities["capabilities"]
    );
    assert_eq!(archive_capabilities["effectiveEngine"], "rust");
    assert_eq!(archive_capabilities["fallbackSafe"], true);
    assert_eq!(archive_capabilities["accepted"], false);
}

#[test]
fn verifies_extracts_publishes_and_manifests_payload_with_acceptance_receipts() {
    let root = tempdir().unwrap();
    let archive = root.path().join("payload.zip");
    let staging = root.path().join("staging");
    let destination = root.path().join("generation");
    let manifest = root.path().join("workspace-manifest.json");
    write_archive(&archive, b"payload-body");
    let expected = format!("{:x}", Sha256::digest(fs::read(&archive).unwrap()));

    let (code, verified, stderr) = run(&[
        "payload",
        "verify",
        archive.to_str().unwrap(),
        &expected,
        "1000000",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(verified["capability"], "payload.verify");
    assert_eq!(verified["accepted"], false);
    assert_eq!(verified["fallbackSafe"], true);

    let (code, extracted, stderr) = run(&[
        "payload",
        "extract",
        archive.to_str().unwrap(),
        "auto",
        staging.to_str().unwrap(),
        "1000000",
        "100000",
        "200000",
        "1",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(extracted["accepted"], true);
    assert_eq!(extracted["fallbackSafe"], false);
    assert_eq!(fs::read(staging.join("file.bin")).unwrap(), b"payload-body");

    let (code, published, stderr) = run(&[
        "payload",
        "publish",
        staging.to_str().unwrap(),
        destination.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(published["accepted"], true);
    assert_eq!(published["alreadyPublished"], false);

    let (code, rebuilt, stderr) = run(&[
        "workspace",
        "manifest",
        destination.to_str().unwrap(),
        manifest.to_str().unwrap(),
        "1000",
        "100000",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rebuilt["state"], "ready");
    assert_eq!(rebuilt["accepted"], true);
    let body: Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
    assert!(
        body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "file.bin")
    );
}

#[test]
fn payload_errors_bound_fallback_to_the_pre_acceptance_phase() {
    let root = tempdir().unwrap();
    let archive = root.path().join("payload.zip");
    let staging = root.path().join("staging");
    write_archive(&archive, b"payload-body");

    let (code, mismatch, _) = run(&[
        "payload",
        "verify",
        archive.to_str().unwrap(),
        &"0".repeat(64),
        "1000000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(mismatch["errorCode"], "sha256_mismatch");
    assert_eq!(mismatch["accepted"], false);
    assert_eq!(mismatch["fallbackSafe"], true);

    fs::create_dir(&staging).unwrap();
    let destination = root.path().join("destination");
    fs::create_dir(&destination).unwrap();
    let (code, conflict, _) = run(&[
        "payload",
        "publish",
        staging.to_str().unwrap(),
        destination.to_str().unwrap(),
    ]);
    assert_eq!(code, 0);
    assert_eq!(conflict["accepted"], true);
    assert_eq!(conflict["fallbackSafe"], false);
    assert!(destination.is_dir());
}

#[test]
fn workspace_watch_streams_machine_readable_states_and_stops_on_control_eof() {
    let root = tempdir().unwrap();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let manifest = root.path().join("manifest.json");
    fs::write(workspace.join("file"), b"body").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_rudder-native"))
        .args([
            "workspace",
            "watch",
            workspace.to_str().unwrap(),
            manifest.to_str().unwrap(),
            "1000",
            "100000",
            "50",
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let lines = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        lines
            .iter()
            .map(|line| line["state"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["building", "ready", "stopped"]
    );
    assert!(
        lines
            .iter()
            .all(|line| line["capability"] == "workspace.watch")
    );
    assert!(lines.iter().all(|line| line["accepted"] == true));
}

#[test]
fn indexes_run_evidence_without_materializing_the_source() {
    let root = tempdir().unwrap();
    let input = root.path().join("run.ndjson");
    let output = root.path().join("run.index.ndjson");
    fs::write(
        &input,
        concat!(
            r#"{"ts":"2026-08-13T00:00:00Z","stream":"stdout","chunk":"hello"}"#,
            "\n",
            r#"{"ts":"2026-08-13T00:00:01Z","stream":"stderr","chunk":"world"}"#,
            "\n"
        ),
    )
    .unwrap();
    let (code, result, stderr) = run(&[
        "evidence",
        "index",
        input.to_str().unwrap(),
        output.to_str().unwrap(),
        "1024",
        "10",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(result["operation"], "indexEvidence");
    assert_eq!(result["recordCount"], 2);
    assert_eq!(result["sourceBytes"], fs::metadata(&input).unwrap().len());
    let lines = fs::read_to_string(output).unwrap();
    assert_eq!(lines.lines().count(), 2);
    assert!(lines.contains("\"sourceOffset\":0"));
    assert!(lines.contains("\"stream\":\"stderr\""));
}

#[test]
fn creates_file_backed_archive_from_bounded_plan() {
    let root = tempdir().unwrap();
    let manifest = root.path().join("manifest.json");
    let source = root.path().join("source.bin");
    let plan = root.path().join("plan.json");
    let archive = root.path().join("created.zip");
    let extracted = root.path().join("extracted.bin");
    let body = vec![6; 64 * 1024 * 2 + 7];
    fs::write(&manifest, br#"{"version":2}"#).unwrap();
    fs::write(&source, &body).unwrap();
    fs::write(
        &plan,
        serde_json::to_vec(&serde_json::json!({
            "protocolVersion": 1,
            "manifestSource": manifest,
            "treeSha256": "1111111111111111111111111111111111111111111111111111111111111111",
            "entries": [
                { "kind": "directory", "archivePath": "workspace/" },
                { "kind": "file", "archivePath": "workspace/file.bin", "sourcePath": source }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let (code, capabilities, stderr) = run(&["archive", "capabilities"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(capabilities["protocolVersion"], 1);
    assert!(
        capabilities["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "archive.create")
    );

    let (code, created, stderr) = run(&[
        "archive",
        "create",
        plan.to_str().unwrap(),
        archive.to_str().unwrap(),
        "1000000",
        "500000",
        "500000",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(created["protocolVersion"], 1);
    assert_eq!(created["entryCount"], 3);
    assert_eq!(created["treeSha256"], "1".repeat(64));
    assert_eq!(created["byteSize"], fs::metadata(&archive).unwrap().len());

    let (code, inspected, stderr) = run(&[
        "archive",
        "inspect-manifest",
        archive.to_str().unwrap(),
        "1000000",
        "1024",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(inspected["manifestBase64"], "eyJ2ZXJzaW9uIjoyfQ==");
    assert_eq!(inspected["sha256"], created["manifestSha256"]);

    let (code, result, stderr) = run(&[
        "archive",
        "extract-file",
        archive.to_str().unwrap(),
        "workspace/file.bin",
        extracted.to_str().unwrap(),
        "1000000",
        "500000",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(result["byteSize"], body.len() as u64);
    assert_eq!(fs::read(extracted).unwrap(), body);
}

#[test]
fn create_rejects_unsafe_sources_bounds_and_existing_output() {
    let root = tempdir().unwrap();
    let manifest = root.path().join("manifest.json");
    let source = root.path().join("source.bin");
    let plan = root.path().join("plan.json");
    let output = root.path().join("archive.zip");
    fs::write(&manifest, b"{}").unwrap();
    fs::write(&source, vec![3; 1024]).unwrap();
    let write_plan = |archive_path: &str, source_path: &Path| {
        fs::write(
            &plan,
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion": 1,
                "manifestSource": manifest,
                "treeSha256": "2222222222222222222222222222222222222222222222222222222222222222",
                "entries": [{ "kind": "file", "archivePath": archive_path, "sourcePath": source_path }]
            }))
            .unwrap(),
        )
        .unwrap();
    };
    write_plan("../unsafe", &source);
    let (code, error, _) = run(&[
        "archive",
        "create",
        plan.to_str().unwrap(),
        output.to_str().unwrap(),
        "100000",
        "2000",
        "3000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "unsafe_entry_name");
    assert_no_create_artifacts(root.path(), &output);

    write_plan("workspace/file.bin", Path::new("relative.bin"));
    let (code, error, _) = run(&[
        "archive",
        "create",
        plan.to_str().unwrap(),
        output.to_str().unwrap(),
        "100000",
        "2000",
        "3000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "absolute_existing_paths_required");
    assert_no_create_artifacts(root.path(), &output);

    write_plan("workspace/file.bin", &source);
    let (code, error, _) = run(&[
        "archive",
        "create",
        plan.to_str().unwrap(),
        output.to_str().unwrap(),
        "100000",
        "100",
        "3000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "source_size_limit");
    assert_no_create_artifacts(root.path(), &output);

    write_plan("workspace/file.bin", &source);
    let (code, error, _) = run(&[
        "archive",
        "create",
        plan.to_str().unwrap(),
        output.to_str().unwrap(),
        "100",
        "2000",
        "3000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "archive_size_limit");
    assert_no_create_artifacts(root.path(), &output);

    fs::write(&output, b"keep").unwrap();
    let (code, error, _) = run(&[
        "archive",
        "create",
        plan.to_str().unwrap(),
        output.to_str().unwrap(),
        "100000",
        "2000",
        "3000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "output_exists");
    assert_eq!(fs::read(output).unwrap(), b"keep");
}

#[test]
fn create_rejects_duplicates_case_collisions_and_nonregular_sources() {
    let root = tempdir().unwrap();
    let manifest = root.path().join("manifest.json");
    let source = root.path().join("source.bin");
    let directory = root.path().join("directory");
    let plan = root.path().join("plan.json");
    let output = root.path().join("archive.zip");
    fs::write(&manifest, b"{}").unwrap();
    fs::write(&source, b"body").unwrap();
    fs::create_dir(&directory).unwrap();
    let write_entries = |entries: Value| {
        fs::write(
            &plan,
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion": 1,
                "manifestSource": manifest,
                "treeSha256": "3333333333333333333333333333333333333333333333333333333333333333",
                "entries": entries
            }))
            .unwrap(),
        )
        .unwrap();
    };
    for entries in [
        serde_json::json!([{ "kind": "file", "archivePath": MANIFEST, "sourcePath": source }]),
        serde_json::json!([
            { "kind": "file", "archivePath": "workspace/A", "sourcePath": source },
            { "kind": "file", "archivePath": "workspace/a", "sourcePath": source }
        ]),
    ] {
        write_entries(entries);
        let (code, error, _) = run(&[
            "archive",
            "create",
            plan.to_str().unwrap(),
            output.to_str().unwrap(),
            "100000",
            "2000",
            "3000",
        ]);
        assert_eq!(code, 2);
        assert_eq!(error["errorCode"], "duplicate_entry_name");
        assert_no_create_artifacts(root.path(), &output);
    }

    write_entries(
        serde_json::json!([{ "kind": "file", "archivePath": "workspace/file", "sourcePath": directory }]),
    );
    let (code, error, _) = run(&[
        "archive",
        "create",
        plan.to_str().unwrap(),
        output.to_str().unwrap(),
        "100000",
        "2000",
        "3000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "source_not_regular_file");
    assert_no_create_artifacts(root.path(), &output);

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = root.path().join("source-link");
        symlink(&source, &link).unwrap();
        write_entries(
            serde_json::json!([{ "kind": "file", "archivePath": "workspace/file", "sourcePath": link }]),
        );
        let (code, error, _) = run(&[
            "archive",
            "create",
            plan.to_str().unwrap(),
            output.to_str().unwrap(),
            "100000",
            "2000",
            "3000",
        ]);
        assert_eq!(code, 2);
        assert_eq!(error["errorCode"], "source_not_regular_file");
        assert_no_create_artifacts(root.path(), &output);
    }
}

#[test]
fn returns_manifest_bytes_and_streams_selected_file() {
    let root = tempdir().unwrap();
    let archive = root.path().join("workspace.zip");
    let output = root.path().join("file.bin");
    let body = vec![5; 64 * 1024 * 3 + 19];
    write_archive(&archive, &body);

    let (code, manifest, stderr) = run(&[
        "archive",
        "inspect-manifest",
        archive.to_str().unwrap(),
        "1000000",
        "1024",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(manifest["ok"], true);
    assert_eq!(manifest["manifestBase64"], "eyJ2ZXJzaW9uIjoyfQ==");

    let (code, extracted, stderr) = run(&[
        "archive",
        "extract-file",
        archive.to_str().unwrap(),
        "workspace/file.bin",
        output.to_str().unwrap(),
        "1000000",
        "500000",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(extracted["byteSize"], body.len() as u64);
    assert_eq!(fs::read(output).unwrap(), body);
}

#[test]
fn preserves_existing_output_and_cleans_partial_output_on_failure() {
    let root = tempdir().unwrap();
    let archive = root.path().join("workspace.zip");
    let existing = root.path().join("existing.bin");
    let partial = root.path().join("partial.bin");
    let body = vec![8; 4096];
    write_archive(&archive, &body);
    fs::write(&existing, b"keep").unwrap();

    let mut corrupt = fs::read(&archive).unwrap();
    let body_offset = selected_body_offset(&corrupt, &body);
    corrupt[body_offset + body.len() - 1] ^= 0xff;
    fs::write(&archive, corrupt).unwrap();
    let (code, error, _) = run(&[
        "archive",
        "extract-file",
        archive.to_str().unwrap(),
        "workspace/file.bin",
        existing.to_str().unwrap(),
        "1000000",
        "5000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "output_exists");
    assert_eq!(fs::read(existing).unwrap(), b"keep");

    let (code, error, _) = run(&[
        "archive",
        "extract-file",
        archive.to_str().unwrap(),
        "workspace/file.bin",
        partial.to_str().unwrap(),
        "1000000",
        "5000",
    ]);
    assert_eq!(code, 2);
    assert_eq!(error["errorCode"], "entry_integrity_failed");
    assert!(!partial.exists());
}
