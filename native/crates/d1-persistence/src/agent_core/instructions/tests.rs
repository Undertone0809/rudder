use super::*;
use std::collections::BTreeMap;
const ORG: &str = "10000000-0000-4000-8000-000000000001";
#[test]
fn canonical_workspace_tolerates_corrupt_optional_alias_probe() {
    let f = Fixture::new();
    f.run().unwrap();
    disk::write(
        f.workspace().join(".rudder-workspace-migrations.json"),
        "invalid JSON",
    )
    .unwrap();
    assert_eq!(f.run().unwrap(), Value::Null);
}
#[test]
fn migration_resolves_relative_aliases_against_signed_host_cwd() {
    let f = Fixture::new();
    f.run().unwrap();
    atomic_json(
        &f.workspace().join(".rudder-workspace-migrations.json"),
        &json!({"version":1,"compatibilityAliases":["relative-old-alias"]}),
    )
    .unwrap();
    disk::create_dir_all(&f.host.previous_documents_root).unwrap();
    disk::write(
        Path::new(&f.host.previous_documents_root).join("legacy.txt"),
        "legacy",
    )
    .unwrap();
    f.run().unwrap();
    let state = json(&f.workspace().join(".rudder-workspace-migrations.json")).unwrap();
    assert!(
        state["compatibilityAliases"]
            .as_array()
            .unwrap()
            .contains(&json!(f.root.path().join("relative-old-alias")))
    );
}
#[test]
fn historical_instruction_match_rejects_escaping_instances_root() {
    let mut f = Fixture::new();
    let outside = f
        .root
        .path()
        .join("organizations/100000000000/workspaces/agents/builder-key/instructions");
    disk::create_dir_all(&outside).unwrap();
    disk::create_dir_all(f.root.path().join("instances")).unwrap();
    disk::write(outside.join("SOUL.md"), "Outside historical roots").unwrap();
    f.row["agentRuntimeConfig"] = json!({"instructionsFilePath":format!("{}/instances/../organizations/100000000000/workspaces/agents/builder-key/instructions/SOUL.md",f.root.path().to_string_lossy())});
    assert_eq!(f.run().unwrap(), Value::Null);
    assert!(!f.instructions().join("SOUL.md").exists());
}
#[test]
fn no_replace_publication_keeps_an_existing_destination() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("stage");
    let target = root.path().join("existing");
    disk::write(&source, "new").unwrap();
    disk::write(&target, "existing").unwrap();
    assert_eq!(
        publish_new(&source, &target).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(disk::read_to_string(&target).unwrap(), "existing");
    assert_eq!(disk::read_to_string(&source).unwrap(), "new");
}

#[test]
fn durable_bundle_replays_after_partial_filesystem_progress_without_overwrite() {
    let f = Fixture::new();
    let bundle = AgentCreateInstructionsBundle {
        entry_file: "SOUL.md".into(),
        files: BTreeMap::from([
            ("SOUL.md".into(), "desired soul".into()),
            ("nested/TOOLS.md".into(), "desired tools".into()),
        ]),
        clear_legacy_prompt_template: false,
    };
    disk::create_dir_all(f.instructions().join("nested")).unwrap();
    disk::write(f.instructions().join("SOUL.md"), "operator edit").unwrap();
    materialize_bundle_for_test(&f.host, ORG, "builder-key", &bundle, f.root.path()).unwrap();
    assert_eq!(
        disk::read_to_string(f.instructions().join("SOUL.md")).unwrap(),
        "operator edit"
    );
    assert_eq!(
        disk::read_to_string(f.instructions().join("nested/TOOLS.md")).unwrap(),
        "desired tools"
    );
    // A retry after a crash between file publication and the DB state update
    // is a no-op and does not replace the existing bytes.
    materialize_bundle_for_test(&f.host, ORG, "builder-key", &bundle, f.root.path()).unwrap();
    assert_eq!(
        disk::read_to_string(f.instructions().join("SOUL.md")).unwrap(),
        "operator edit"
    );
}

#[test]
fn durable_bundle_rejects_traversal_and_relative_host_facts() {
    let f = Fixture::new();
    let bundle = AgentCreateInstructionsBundle {
        entry_file: "nested/../SOUL.md".into(),
        files: BTreeMap::new(),
        clear_legacy_prompt_template: false,
    };
    assert!(
        materialize_bundle_for_test(&f.host, ORG, "builder-key", &bundle, f.root.path()).is_err()
    );
    let mut host = f.host.clone();
    host.workspace_home = "relative-workspace".into();
    let bundle = AgentCreateInstructionsBundle {
        entry_file: "SOUL.md".into(),
        files: BTreeMap::new(),
        clear_legacy_prompt_template: false,
    };
    assert!(
        materialize_bundle_for_test(&host, ORG, "builder-key", &bundle, f.root.path()).is_err()
    );
}

#[cfg(unix)]
#[test]
fn durable_bundle_rejects_symlinked_agent_root_before_writing() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let workspace = f.workspace();
    disk::create_dir_all(&workspace).unwrap();
    let outside = f.root.path().join("outside");
    disk::create_dir_all(&outside).unwrap();
    symlink(&outside, workspace.join("agents")).unwrap();
    let bundle = AgentCreateInstructionsBundle {
        entry_file: "SOUL.md".into(),
        files: BTreeMap::from([("SOUL.md".into(), "blocked".into())]),
        clear_legacy_prompt_template: false,
    };
    assert!(
        materialize_bundle_for_test(&f.host, ORG, "builder-key", &bundle, f.root.path()).is_err()
    );
    assert!(!outside.join("builder-key/instructions/SOUL.md").exists());
}

#[cfg(unix)]
#[test]
fn durable_bundle_rejects_symlinked_targets_and_nested_parents() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    f.run().unwrap();
    let outside = f.root.path().join("outside");
    disk::create_dir_all(&outside).unwrap();
    let target = outside.join("target.md");
    disk::write(&target, "outside").unwrap();
    symlink(&target, f.instructions().join("SOUL.md")).unwrap();
    let bundle = AgentCreateInstructionsBundle {
        entry_file: "SOUL.md".into(),
        files: BTreeMap::from([("SOUL.md".into(), "blocked".into())]),
        clear_legacy_prompt_template: false,
    };
    assert!(
        materialize_bundle_for_test(&f.host, ORG, "builder-key", &bundle, f.root.path()).is_err()
    );
    assert_eq!(disk::read_to_string(target).unwrap(), "outside");

    disk::remove_file(f.instructions().join("SOUL.md")).unwrap();
    symlink(&outside, f.instructions().join("nested")).unwrap();
    let bundle = AgentCreateInstructionsBundle {
        entry_file: "nested/TOOLS.md".into(),
        files: BTreeMap::from([("nested/TOOLS.md".into(), "blocked".into())]),
        clear_legacy_prompt_template: false,
    };
    assert!(
        materialize_bundle_for_test(&f.host, ORG, "builder-key", &bundle, f.root.path()).is_err()
    );
    assert!(!outside.join("TOOLS.md").exists());
}

#[cfg(unix)]
#[test]
fn instruction_read_preflight_rejects_symlinked_entries_and_parents() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    f.run().unwrap();
    let outside = f.root.path().join("outside");
    disk::create_dir_all(&outside).unwrap();
    let outside_file = outside.join("private.md");
    disk::write(&outside_file, "outside").unwrap();

    let linked_file = f.instructions().join("LINK.md");
    symlink(&outside_file, &linked_file).unwrap();
    assert!(preflight_root(&f.instructions(), false).is_err());
    assert!(preflight_file(&linked_file).is_err());

    disk::remove_file(&linked_file).unwrap();
    let linked_parent = f.instructions().join("nested");
    symlink(&outside, &linked_parent).unwrap();
    let nested_file = linked_parent.join("TOOLS.md");
    assert!(preflight_root(&f.instructions(), false).is_err());
    assert!(preflight_file(&nested_file).is_err());

    let linked_ancestor = f.root.path().join("linked-parent");
    disk::create_dir_all(outside.join("instructions")).unwrap();
    symlink(&outside, &linked_ancestor).unwrap();
    assert!(preflight_root(&linked_ancestor.join("instructions"), false).is_err());
}

#[cfg(unix)]
#[test]
fn historical_recovery_rejects_symlink_ancestors_before_managed_writes() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new();
    let outside = f.root.path().join("outside-history");
    let suffix = "organizations/100000000000/workspaces/agents/builder-key/instructions";
    let source = outside.join(suffix);
    disk::create_dir_all(&source).unwrap();
    disk::write(source.join("SOUL.md"), "Must not copy this").unwrap();
    let instances = Path::new(&f.host.instance_root).parent().unwrap();
    disk::create_dir_all(instances).unwrap();
    let historical = instances.join("historical");
    symlink(&outside, &historical).unwrap();
    f.row["agentRuntimeConfig"] =
        json!({"instructionsFilePath":historical.join(suffix).join("SOUL.md")});
    assert!(f.run().is_err());
    assert!(!f.instructions().exists());
    assert_eq!(
        disk::read_to_string(source.join("SOUL.md")).unwrap(),
        "Must not copy this"
    );
}

#[test]
fn legacy_absolute_file_normalizes_only_for_managed_root_matching() {
    let mut f = Fixture::new();
    let instructions =
        Path::new(&f.host.previous_documents_root).join("agents/builder-key/instructions");
    disk::create_dir_all(instructions.join("folder")).unwrap();
    disk::write(instructions.join("SOUL.md"), "Legacy file bytes").unwrap();
    f.row["agentRuntimeConfig"] = json!({"instructionsFilePath":format!("{}/folder/../SOUL.md",instructions.to_string_lossy())});
    assert_eq!(f.run().unwrap(), json!("agents/builder-key/instructions"));
    assert_eq!(
        disk::read_to_string(f.instructions().join("SOUL.md")).unwrap(),
        "Legacy file bytes"
    );
}
#[test]
fn foreign_workspace_identity_rejects_before_layout_or_migration_writes() {
    let f = Fixture::new();
    disk::create_dir_all(f.workspace()).unwrap();
    atomic_json(
        &f.workspace().join(".rudder-workspace.json"),
        &json!({"version":1,"orgId":"foreign-org"}),
    )
    .unwrap();
    let before = disk::read(f.workspace().join(".rudder-workspace.json")).unwrap();
    assert!(f.run().is_err());
    assert_eq!(
        disk::read_dir(f.workspace())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>(),
        vec![std::ffi::OsString::from(".rudder-workspace.json")]
    );
    assert_eq!(
        disk::read(f.workspace().join(".rudder-workspace.json")).unwrap(),
        before
    );
    assert!(!Path::new(&f.host.previous_documents_root).exists());
}
#[test]
fn migration_no_replace_preserves_external_writer_after_missing_target_check() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    disk::write(&source, "source bytes").unwrap();
    let source_identity = identity(&source).unwrap();
    assert!(lstat(&target).unwrap().is_none());
    let writer_target = target.clone();
    std::thread::spawn(move || disk::write(writer_target, "external writer bytes").unwrap())
        .join()
        .unwrap();
    assert_eq!(
        rename_new(&source, &target).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(disk::read_to_string(&source).unwrap(), "source bytes");
    assert_eq!(identity(&source).unwrap(), source_identity);
    assert_eq!(
        disk::read_to_string(&target).unwrap(),
        "external writer bytes"
    );
}
struct Fixture {
    root: tempfile::TempDir,
    host: Host,
    row: Value,
}
impl Fixture {
    fn new() -> Self {
        // System temporary paths can contain aliases such as macOS /tmp.
        // Owned-root fixtures use canonical paths; the symlink cases below
        // explicitly introduce the untrusted aliases they need to reject.
        let temporary_root = std::env::temp_dir().canonicalize().unwrap();
        let root = tempfile::tempdir_in(temporary_root).unwrap();
        let instance = root.path().join("instances/default");
        let host = Host {
            workspace_home: instance.join("organizations").to_string_lossy().into(),
            instance_root: instance.to_string_lossy().into(),
            previous_documents_root: root
                .path()
                .join("Documents/instances/default/organizations/100000000000/workspaces")
                .to_string_lossy()
                .into(),
            friendly_workspace_home: false,
            hostname: "synthetic-fixture-host".into(),
        };
        let row = json!({"id":"20000000-0000-4000-8000-000000000002","orgId":ORG,"name":"Builder","role":"engineer","workspaceKey":"builder-key","agentRuntimeConfig":{}});
        Self { root, host, row }
    }
    fn workspace(&self) -> PathBuf {
        Path::new(&self.host.workspace_home).join("100000000000/workspaces")
    }
    fn instructions(&self) -> PathBuf {
        self.workspace().join("agents/builder-key/instructions")
    }
    fn run(&self) -> io::Result<Value> {
        let _guard =
            lock::Guard::acquire(Path::new(&self.host.workspace_home), &self.host.hostname)?;
        recover(
            &self.host,
            &self.row,
            &self.root.path().to_string_lossy(),
            &self.root.path().to_string_lossy(),
        )
    }
}
#[test]
fn native_layout_and_instruction_modes_preserve_existing_content() {
    let mut f = Fixture::new();
    assert_eq!(f.run().unwrap(), Value::Null);
    assert_eq!(
        json(&f.workspace().join(".rudder-workspace.json")).unwrap()["orgId"],
        ORG
    );
    for dir in ["instructions", "memory", "life", "skills"] {
        assert!(f.workspace().join("agents/builder-key").join(dir).is_dir());
    }
    disk::write(
        f.instructions().join("custom.md"),
        "Existing custom content",
    )
    .unwrap();
    assert_eq!(f.run().unwrap(), json!("agents/builder-key/instructions"));
    assert!(!f.instructions().join("SOUL.md").exists());
    f.row["agentRuntimeConfig"] = json!({"instructionsBundleMode":"external","instructionsRootPath":f.root.path().join("external")});
    assert_eq!(f.run().unwrap(), Value::Null);
    assert_eq!(
        disk::read_to_string(f.instructions().join("custom.md")).unwrap(),
        "Existing custom content"
    );
    f.row["agentRuntimeConfig"] = json!({"instructionsBundleMode":"managed","instructionsRootPath":f.root.path().join("missing")});
    assert_eq!(f.run().unwrap(), json!("agents/builder-key/instructions"));
}
#[test]
fn legacy_root_migration_preserves_inode_alias_and_edited_instructions() {
    let mut f = Fixture::new();
    let legacy = Path::new(&f.host.previous_documents_root).to_path_buf();
    let instructions = legacy.join("agents/builder-key/instructions");
    disk::create_dir_all(&instructions).unwrap();
    disk::write(
        instructions.join("CUSTOM.md"),
        "User's existing instructions",
    )
    .unwrap();
    let inode = identity(&legacy).unwrap();
    f.row["agentRuntimeConfig"] = json!({"instructionsBundleMode":"managed","instructionsRootPath":instructions,"instructionsEntryFile":"CUSTOM.md"});
    assert_eq!(f.run().unwrap(), json!("agents/builder-key/instructions"));
    assert_eq!(identity(&f.workspace()).unwrap(), inode);
    assert!(same_directory(&legacy, &f.workspace()));
    assert_eq!(
        disk::read_to_string(f.instructions().join("CUSTOM.md")).unwrap(),
        "User's existing instructions"
    );
    assert_eq!(
        disk::read_to_string(f.instructions().join("SOUL.md")).unwrap(),
        defaults(false)["SOUL.md"]
    );
    let before = disk::read(f.instructions().join("CUSTOM.md")).unwrap();
    f.run().unwrap();
    assert_eq!(
        disk::read(f.instructions().join("CUSTOM.md")).unwrap(),
        before
    );
}
#[test]
fn conflicting_roots_preserve_both_originals() {
    let f = Fixture::new();
    let legacy = Path::new(&f.host.previous_documents_root);
    disk::create_dir_all(legacy).unwrap();
    disk::create_dir_all(f.workspace()).unwrap();
    disk::write(legacy.join("work.txt"), "legacy").unwrap();
    disk::write(f.workspace().join("work.txt"), "current").unwrap();
    assert!(f.run().is_err());
    assert_eq!(
        disk::read_to_string(legacy.join("work.txt")).unwrap(),
        "legacy"
    );
    assert_eq!(
        disk::read_to_string(f.workspace().join("work.txt")).unwrap(),
        "current"
    );
}
#[test]
fn duplicate_roots_archive_without_losing_original_bytes() {
    let f = Fixture::new();
    let legacy = Path::new(&f.host.previous_documents_root);
    disk::create_dir_all(legacy).unwrap();
    disk::create_dir_all(f.workspace()).unwrap();
    disk::write(legacy.join("work.txt"), "identical").unwrap();
    disk::write(f.workspace().join("work.txt"), "identical").unwrap();
    let inode = identity(legacy).unwrap();
    f.run().unwrap();
    assert_eq!(identity(&f.workspace()).unwrap(), inode);
    assert!(same_directory(legacy, &f.workspace()));
    let backups = disk::read_dir(legacy.parent().unwrap().join(".rudder-migration-backups"))
        .unwrap()
        .collect::<io::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        disk::read_to_string(backups[0].path().join("work.txt")).unwrap(),
        "identical"
    );
}
#[test]
fn mapped_missing_and_foreign_identity_fail_closed() {
    let mut f = Fixture::new();
    f.host.friendly_workspace_home = true;
    disk::create_dir_all(&f.host.workspace_home).unwrap();
    atomic_json(&Path::new(&f.host.workspace_home).join(".rudder-organizations.json"),&json!({"version":1,"organizations":[{"instanceId":"default","orgId":ORG,"folderName":"my-org","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]})).unwrap();
    assert!(f.run().is_err());
    let mapped = Path::new(&f.host.workspace_home).join("my-org");
    disk::create_dir_all(&mapped).unwrap();
    atomic_json(
        &mapped.join(".rudder-workspace.json"),
        &json!({"version":1,"orgId":"other-org"}),
    )
    .unwrap();
    assert!(f.run().is_err());
    assert_eq!(
        json(&mapped.join(".rudder-workspace.json")).unwrap()["orgId"],
        "other-org"
    );
}
#[test]
fn live_and_unrecognized_workspace_locks_are_preserved() {
    let f = Fixture::new();
    let home = Path::new(&f.host.workspace_home);
    let guard = lock::Guard::acquire(home, &f.host.hostname).unwrap();
    let lock_path = home.join(".rudder-organizations.lock");
    let before = identity(&lock_path).unwrap();
    assert!(before.1 > 0);
    drop(guard);
    assert!(!lock_path.exists());
    disk::create_dir(&lock_path).unwrap();
    disk::write(lock_path.join("user-owned.txt"), "retain").unwrap();
    assert!(lock::Guard::acquire(home, &f.host.hostname).is_err());
    assert_eq!(
        disk::read_to_string(lock_path.join("user-owned.txt")).unwrap(),
        "retain"
    );
}
#[test]
fn typed_instruction_path_normalization_matches_legacy_rules() {
    for (input, expected) in [
        ("/a/../SOUL.md", "SOUL.md"),
        ("a\\b.md", "a/b.md"),
        ("./x.md", "x.md"),
        ("/../../SOUL.md", "SOUL.md"),
    ] {
        assert_eq!(relative(input).unwrap(), expected);
    }
    for input in ["", ".", "..", "a/../../secret"] {
        assert!(relative(input).is_err());
    }
}

#[test]
fn instruction_language_matches_node_extension_labels() {
    for (path, expected) in [
        ("SOUL.md", "markdown"),
        ("config.json", "json"),
        ("config.yaml", "yaml"),
        ("src/agent.ts", "typescript"),
        ("src/agent.tsx", "typescript"),
        ("src/agent.js", "javascript"),
        ("src/agent.jsx", "javascript"),
        ("src/agent.mjs", "javascript"),
        ("src/agent.cjs", "javascript"),
        ("scripts/run.sh", "bash"),
        ("scripts/run.py", "python"),
        ("config.toml", "toml"),
        ("notes.txt", "text"),
        ("README", "text"),
    ] {
        assert_eq!(
            infer_language(path),
            expected,
            "unexpected language for {path}"
        );
    }
}

#[test]
fn durable_operation_markers_are_not_published_as_files() {
    let bundle = decode_durable_bundle(
        "SOUL.md",
        r#"{"SOUL.md":"updated","__rudderDeletes":["docs/OLD.md"],"__rudderReplace":true}"#,
        false,
    )
    .unwrap();
    assert_eq!(
        bundle.files.get("SOUL.md").map(String::as_str),
        Some("updated")
    );
    assert!(!bundle.files.contains_key("__rudderDeletes"));
    assert!(!bundle.files.contains_key("__rudderReplace"));
    assert_eq!(bundle.deletions, vec!["docs/OLD.md"]);
    assert!(bundle.replace_existing);
}

#[test]
fn durable_operation_markers_fail_closed_on_invalid_deletions() {
    for files in [
        r#"{"SOUL.md":"updated","__rudderDeletes":"docs/OLD.md"}"#,
        r#"{"SOUL.md":"updated","__rudderDeletes":["../outside.md"]}"#,
        r#"{"SOUL.md":"updated","__rudderDeletes":[42]}"#,
    ] {
        assert!(decode_durable_bundle("SOUL.md", files, false).is_err());
    }
}

#[test]
fn durable_replace_snapshot_updates_and_deletes_only_bundle_files() {
    let f = Fixture::new();
    f.run().unwrap();
    disk::create_dir_all(f.instructions().join("docs")).unwrap();
    disk::write(f.instructions().join("SOUL.md"), "before").unwrap();
    disk::write(f.instructions().join("docs/OLD.md"), "remove").unwrap();
    disk::write(f.instructions().join("docs/KEEP.md"), "keep").unwrap();

    let bundle = decode_durable_bundle(
        "SOUL.md",
        r#"{"SOUL.md":"after","docs/KEEP.md":"keep","__rudderDeletes":["docs/OLD.md"],"__rudderReplace":true}"#,
        false,
    )
    .unwrap();
    validate_host_paths(&f.host, f.root.path()).unwrap();
    let _guard = lock::Guard::acquire(Path::new(&f.host.workspace_home), &f.host.hostname).unwrap();
    materialize_bundle_locked(&f.host, ORG, "builder-key", &bundle, f.root.path()).unwrap();

    assert_eq!(
        disk::read_to_string(f.instructions().join("SOUL.md")).unwrap(),
        "after"
    );
    assert_eq!(
        disk::read_to_string(f.instructions().join("docs/KEEP.md")).unwrap(),
        "keep"
    );
    assert!(!f.instructions().join("docs/OLD.md").exists());
    assert!(!f.instructions().join("__rudderDeletes").exists());
    assert!(!f.instructions().join("__rudderReplace").exists());
}

#[cfg(unix)]
#[test]
fn durable_delete_rejects_symlink_targets_without_touching_outside_root() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    f.run().unwrap();
    let outside = f.root.path().join("outside.md");
    disk::write(&outside, "outside").unwrap();
    symlink(&outside, f.instructions().join("DELETE.md")).unwrap();

    let bundle = decode_durable_bundle(
        "SOUL.md",
        r#"{"SOUL.md":"after","__rudderDeletes":["DELETE.md"],"__rudderReplace":true}"#,
        false,
    )
    .unwrap();
    validate_host_paths(&f.host, f.root.path()).unwrap();
    let _guard = lock::Guard::acquire(Path::new(&f.host.workspace_home), &f.host.hostname).unwrap();
    assert!(
        materialize_bundle_locked(&f.host, ORG, "builder-key", &bundle, f.root.path()).is_err()
    );
    assert_eq!(disk::read_to_string(&outside).unwrap(), "outside");
    assert!(f.instructions().join("DELETE.md").exists());
}
