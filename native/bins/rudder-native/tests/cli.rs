use crc32fast::Hasher as Crc32;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;
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
            "evidence.read",
            "workspace.watch",
            "payload.verify",
            "payload.extract",
            "payload.probeVersion",
            "payload.publish",
            "plugin.inspectArchive"
        ])
    );
    assert!(stderr.is_empty());

    let (code, archive_capabilities, stderr) = run(&["archive", "capabilities"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap(),
        archive_capabilities["capabilities"]
    );
    assert!(
        archive_capabilities["target"]
            .as_str()
            .is_some_and(|target| !target.is_empty())
    );
    assert_eq!(archive_capabilities["effectiveEngine"], "rust");
}

#[test]
fn inspects_bounded_plugin_archive_without_executing_content() {
    let root = tempdir().unwrap();
    let archive = root.path().join("plugin.zip");
    fs::write(
        &archive,
        fixture(&[
            (
                "research-kit/.codex-plugin/plugin.json",
                br#"{"name":"research-kit","version":"1.2.0"}"#,
            ),
            (
                "research-kit/skills/research/SKILL.md",
                b"---\nname: Research\n---\n",
            ),
        ]),
    )
    .unwrap();
    let (code, result, stderr) = run(&[
        "plugin",
        "inspect-archive",
        archive.to_str().unwrap(),
        "10485760",
        "2097152",
        "10485760",
        "500",
        "100",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(result["capability"], "plugin.inspectArchive");
    assert_eq!(result["operation"], "inspectPluginArchive");
    assert_eq!(result["strippedRoot"], "research-kit");
    assert_eq!(result["files"][0]["path"], ".codex-plugin/plugin.json");
    assert_eq!(result["files"][1]["path"], "skills/research/SKILL.md");
}

#[test]
fn watches_workspace_and_stops_on_stdin_eof() {
    use std::process::Stdio;
    use std::thread;
    use std::time::Duration;

    let root = tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let data = root.path().join("data");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&data).unwrap();
    fs::write(workspace.join("alpha.txt"), b"alpha").unwrap();
    let output = data.join("manifest.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-native"))
        .args([
            "workspace",
            "watch",
            workspace.to_str().unwrap(),
            output.to_str().unwrap(),
            "10000",
            "1048576",
            "25",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        let mut lines = String::new();
        std::io::Read::read_to_string(&mut stdout, &mut lines).unwrap();
        lines
    });
    thread::sleep(Duration::from_millis(500));
    for index in 0..6 {
        fs::write(
            workspace.join("nested.txt"),
            format!("nested-{index}\n").as_bytes(),
        )
        .unwrap();
        thread::sleep(Duration::from_millis(300));
    }
    // Allow the cross-platform event queue to deliver the final mutation before
    // EOF asks the watcher to stop.
    thread::sleep(Duration::from_secs(1));
    drop(child.stdin.take());
    let status = child.wait().unwrap();
    let lines = reader.join().unwrap();
    assert!(status.success(), "watch exited with {status}: {lines}");
    let envelopes = lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(
        envelopes
            .iter()
            .any(|value| value["capability"] == "workspace.watch" && value["state"] == "building")
    );
    assert!(envelopes.iter().any(|value| value["state"] == "ready"));
    assert!(envelopes.iter().any(|value| value["state"] == "dirty"));
    assert!(envelopes.iter().any(|value| value["state"] == "stopped"));
    assert!(output.exists());
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
    assert!(
        result["target"]
            .as_str()
            .is_some_and(|target| !target.is_empty())
    );
    assert_eq!(result["binaryVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(result["recordCount"], 2);
    assert_eq!(result["sourceBytes"], fs::metadata(&input).unwrap().len());
    let lines = fs::read_to_string(output).unwrap();
    assert_eq!(lines.lines().count(), 2);
    assert!(lines.contains("\"sourceOffset\":0"));
    assert!(lines.contains("\"stream\":\"stderr\""));
}

#[test]
fn reads_bounded_run_evidence_from_shared_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/run-evidence-read-parity.json"
    ))
    .unwrap();
    let root = tempdir().unwrap();
    let input = root.path().join("run.log");
    fs::write(&input, fixture["source"].as_str().unwrap()).unwrap();

    for case in fixture["cases"].as_array().unwrap() {
        let (code, result, stderr) = run(&[
            "evidence",
            "read",
            input.to_str().unwrap(),
            &case["offset"].to_string(),
            &case["limitBytes"].to_string(),
        ]);
        assert_eq!(code, 0, "{stderr}");
        assert_eq!(result["capability"], "evidence.read");
        assert_eq!(result["operation"], "readEvidence");
        assert_eq!(result["content"], case["content"]);
        assert_eq!(result["endOffset"], case["endOffset"]);
        assert_eq!(result["eof"], case["eof"]);
        assert_eq!(result["nextOffset"], case["nextOffset"]);
        assert!(
            result["target"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        assert_eq!(result["binaryVersion"], env!("CARGO_PKG_VERSION"));
    }
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
    assert_eq!(result["accepted"], true);
    assert_eq!(result["byteSize"], body.len() as u64);
    assert_eq!(fs::read(extracted).unwrap(), body);
}

#[test]
fn exposes_runtime_payload_capabilities_and_runs_public_operations() {
    let root = tempdir().unwrap();
    let archive = root.path().join("payload.zip");
    let staging = root.path().join("payload-staging");
    let destination = root.path().join("payload-published");
    let body = b"runtime-payload-body";
    write_archive(&archive, body);
    let archive_bytes = fs::read(&archive).unwrap();
    let expected_sha256 = format!("{:x}", Sha256::digest(&archive_bytes));

    let (code, capabilities, stderr) = run(&["payload", "capabilities"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(capabilities["effectiveEngine"], "rust");
    assert_eq!(capabilities["protocolVersion"], 1);
    assert!(
        capabilities["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "payload.publish")
    );

    let (code, verified, stderr) = run(&[
        "payload",
        "verify",
        archive.to_str().unwrap(),
        &expected_sha256,
        "1048576",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(verified["capability"], "payload.verify");
    assert_eq!(verified["sha256"], expected_sha256);

    let (code, extracted, stderr) = run(&[
        "payload",
        "extract",
        archive.to_str().unwrap(),
        "auto",
        staging.to_str().unwrap(),
        "1048576",
        "1048576",
        "2097152",
        "0",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(extracted["capability"], "payload.extract");
    assert_eq!(extracted["accepted"], true);
    assert!(staging.join("workspace/file.bin").exists());

    let (code, published, stderr) = run(&[
        "payload",
        "publish",
        staging.to_str().unwrap(),
        destination.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(published["capability"], "payload.publish");
    assert_eq!(published["accepted"], true);
    assert_eq!(
        fs::read(destination.join("workspace/file.bin")).unwrap(),
        body
    );
}

#[cfg(unix)]
#[test]
fn probes_runtime_payload_version_without_a_shell() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let executable = bin.join("postgres");
    fs::write(&executable, b"#!/bin/sh\nprintf 'PostgreSQL 18.4\\n'\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let (code, result, stderr) = run(&[
        "payload",
        "probe-version",
        root.path().to_str().unwrap(),
        "bin/postgres",
        "PostgreSQL 18.4",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(result["capability"], "payload.probeVersion");
    assert!(result["versionOutput"].as_str().unwrap().contains("18.4"));
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
