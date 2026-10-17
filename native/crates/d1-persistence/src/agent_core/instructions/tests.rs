use super::*;
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
        let root = tempfile::tempdir().unwrap();
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
