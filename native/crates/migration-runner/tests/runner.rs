use async_trait::async_trait;
use rudder_migration_core::{JournalEntry, MigrationLimits, MigrationManifestOptions};
use rudder_migration_runner::{
    AppliedMigration, HistorySnapshot, LockAcquisition, MigrationExecutor, MigrationRunRequest,
    MigrationRunner, MigrationRunnerConfig, MigrationSource, RecoveryPoint,
};
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tempfile::TempDir;

#[derive(Debug, Clone, PartialEq, Eq)]
struct FakeError(&'static str);

impl Display for FakeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for FakeError {}

#[derive(Debug)]
struct FakeExecutor {
    events: Vec<String>,
    database_non_empty: bool,
    history: HistorySnapshot,
    history_before_transaction: Option<HistorySnapshot>,
    lock_acquired: bool,
    fail_statement: bool,
    fail_postcondition: bool,
}

impl FakeExecutor {
    fn new(database_non_empty: bool, history: HistorySnapshot) -> Self {
        Self {
            events: Vec::new(),
            database_non_empty,
            history,
            history_before_transaction: None,
            lock_acquired: true,
            fail_statement: false,
            fail_postcondition: false,
        }
    }
}

#[async_trait]
impl MigrationExecutor for FakeExecutor {
    type Error = FakeError;

    async fn acquire_advisory_lock(
        &mut self,
        name: &str,
        _timeout: Duration,
    ) -> Result<LockAcquisition, Self::Error> {
        self.events.push(format!("lock:{name}"));
        Ok(LockAcquisition {
            acquired: self.lock_acquired,
        })
    }

    async fn begin(&mut self) -> Result<(), Self::Error> {
        self.events.push("begin".into());
        self.history_before_transaction = Some(self.history.clone());
        Ok(())
    }

    async fn database_non_empty(&mut self) -> Result<bool, Self::Error> {
        self.events.push("database_non_empty".into());
        Ok(self.database_non_empty)
    }

    async fn read_history(&mut self) -> Result<HistorySnapshot, Self::Error> {
        self.events.push("read_history".into());
        Ok(self.history.clone())
    }

    async fn ensure_history_table(&mut self) -> Result<(), Self::Error> {
        self.events.push("ensure_history_table".into());
        self.history.table_exists = true;
        Ok(())
    }

    async fn execute_statement(&mut self, statement: &str) -> Result<(), Self::Error> {
        self.events.push(format!("execute:{statement}"));
        if self.fail_statement {
            return Err(FakeError("statement failed"));
        }
        Ok(())
    }

    async fn record_history(&mut self, entry: &AppliedMigration) -> Result<(), Self::Error> {
        self.events
            .push(format!("record:{}", entry.hash.as_deref().unwrap_or("")));
        self.history.entries.push(entry.clone());
        Ok(())
    }

    async fn check_postconditions(&mut self) -> Result<HistorySnapshot, Self::Error> {
        self.events.push("postcondition".into());
        if self.fail_postcondition {
            return Err(FakeError("postcondition failed"));
        }
        Ok(self.history.clone())
    }

    async fn commit(&mut self) -> Result<(), Self::Error> {
        self.events.push("commit".into());
        self.history_before_transaction = None;
        Ok(())
    }

    async fn rollback(&mut self) -> Result<(), Self::Error> {
        self.events.push("rollback".into());
        if let Some(history) = self.history_before_transaction.take() {
            self.history = history;
        }
        Ok(())
    }

    async fn release_advisory_lock(&mut self) -> Result<(), Self::Error> {
        self.events.push("release".into());
        Ok(())
    }
}

fn limits() -> MigrationLimits {
    MigrationLimits {
        max_journal_bytes: 64 * 1024,
        max_sql_file_bytes: 64 * 1024,
        max_total_sql_bytes: 256 * 1024,
        max_sql_files: 32,
        max_directory_entries: 64,
    }
}

fn fixture(entries: &[(&str, &str)]) -> (TempDir, MigrationSource) {
    let root = tempfile::tempdir().unwrap();
    let migrations = root.path().join("migrations");
    let meta = migrations.join("meta");
    fs::create_dir_all(&meta).unwrap();
    let journal_entries = entries
        .iter()
        .enumerate()
        .map(|(idx, (tag, _))| JournalEntry {
            idx,
            version: "7".into(),
            when: 1_000 + idx as u64,
            tag: (*tag).into(),
            breakpoints: true,
        })
        .collect::<Vec<_>>();
    for (tag, sql) in entries {
        fs::write(migrations.join(format!("{tag}.sql")), sql).unwrap();
    }
    let journal = rudder_migration_core::MigrationJournal {
        version: "7".into(),
        dialect: "postgresql".into(),
        entries: journal_entries,
    };
    let journal_path = meta.join("_journal.json");
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    (
        root,
        MigrationSource::new(
            journal_path,
            migrations,
            MigrationManifestOptions {
                limits: limits(),
                legacy_unjournaled: Vec::new(),
            },
        ),
    )
}

fn valid_recovery() -> RecoveryPoint {
    RecoveryPoint {
        created: true,
        includes_migration_journal: true,
        path: Some("/disposable/pre-migration.sql".into()),
    }
}

fn request(candidate: MigrationSource, recovery: Option<RecoveryPoint>) -> MigrationRunRequest {
    MigrationRunRequest {
        candidate,
        baseline: None,
        recovery,
    }
}

fn history_for(source: &MigrationSource, count: usize) -> HistorySnapshot {
    let manifest = source.load().unwrap();
    HistorySnapshot {
        table_exists: true,
        entries: manifest
            .manifest
            .entries
            .iter()
            .take(count)
            .map(|entry| AppliedMigration {
                hash: Some(entry.sha256.clone()),
                name: Some(entry.file_name.clone()),
                created_at: entry
                    .journal_entry
                    .as_ref()
                    .map(|journal| journal.when as i64),
            })
            .collect(),
    }
}

#[tokio::test]
async fn applies_only_ordered_pending_files_and_returns_durable_receipt() {
    let (_root, source) = fixture(&[
        ("0000_first", "SELECT 1;"),
        ("0001_second", "SELECT 2;--> statement-breakpoint SELECT 3;"),
    ]);
    let history = history_for(&source, 1);
    let mut executor = FakeExecutor::new(true, history);
    let mut runner = MigrationRunner::new(executor, MigrationRunnerConfig::default());

    let receipt = runner
        .run(request(source, Some(valid_recovery())))
        .await
        .unwrap();
    executor = runner.into_executor();

    assert_eq!(receipt.applied_entries.len(), 1);
    assert_eq!(receipt.applied_entries[0].file_name, "0001_second.sql");
    assert!(receipt.lock.acquired);
    assert!(receipt.lock.released);
    assert!(receipt.recovery.required);
    assert_eq!(
        receipt.recovery.path.as_deref(),
        Some("/disposable/pre-migration.sql")
    );
    assert!(receipt.transaction.committed);
    assert!(!receipt.transaction.rolled_back);
    assert!(
        receipt
            .candidate_fingerprint
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    );
    assert!(
        executor
            .events
            .iter()
            .any(|event| event == "execute:SELECT 2;")
    );
    assert!(
        executor
            .events
            .iter()
            .any(|event| event == "execute:SELECT 3;")
    );
    assert!(
        !executor
            .events
            .iter()
            .any(|event| event == "execute:SELECT 1;")
    );
    assert!(
        executor
            .events
            .iter()
            .position(|event| event == "begin")
            .unwrap()
            < executor
                .events
                .iter()
                .position(|event| event == "ensure_history_table")
                .unwrap()
    );
}

#[tokio::test]
async fn refuses_missing_recovery_before_any_mutating_executor_call() {
    let (_root, source) = fixture(&[("0000_first", "CREATE TABLE first_table (id integer);")]);
    let mut runner = MigrationRunner::new(
        FakeExecutor::new(true, HistorySnapshot::empty()),
        MigrationRunnerConfig::default(),
    );

    let error = runner.run(request(source, None)).await.unwrap_err();
    assert_eq!(error.code(), "recovery_required");
    let receipt = error.receipt().unwrap();
    assert!(receipt.transaction.rolled_back);
    let executor = runner.executor();
    assert!(
        !executor
            .events
            .iter()
            .any(|event| event == "ensure_history_table")
    );
    assert!(
        !executor
            .events
            .iter()
            .any(|event| event.starts_with("execute:"))
    );
    assert!(
        !executor
            .events
            .iter()
            .any(|event| event.starts_with("record:"))
    );
}

#[tokio::test]
async fn lock_timeout_fails_closed_without_begin_or_mutation() {
    let (_root, source) = fixture(&[("0000_first", "CREATE TABLE first_table (id integer);")]);
    let mut executor = FakeExecutor::new(false, HistorySnapshot::empty());
    executor.lock_acquired = false;
    let mut runner = MigrationRunner::new(executor, MigrationRunnerConfig::default());

    let error = runner
        .run(request(source, Some(valid_recovery())))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "lock_timeout");
    let executor = runner.executor();
    assert!(executor.events.iter().all(|event| event != "begin"));
    assert!(
        executor
            .events
            .iter()
            .all(|event| !event.starts_with("execute:"))
    );
    assert!(
        executor
            .events
            .iter()
            .all(|event| !event.starts_with("record:"))
    );
}

#[tokio::test]
async fn statement_failure_rolls_back_the_whole_transaction_and_never_commits() {
    let (_root, source) = fixture(&[("0000_first", "CREATE TABLE first_table (id integer);")]);
    let mut executor = FakeExecutor::new(false, HistorySnapshot::empty());
    executor.fail_statement = true;
    let mut runner = MigrationRunner::new(executor, MigrationRunnerConfig::default());

    let error = runner.run(request(source, None)).await.unwrap_err();
    assert_eq!(error.code(), "executor_error");
    let receipt = error.receipt().unwrap();
    assert!(receipt.transaction.rolled_back);
    assert!(!receipt.transaction.committed);
    assert!(receipt.applied_entries.is_empty());
    let executor = runner.executor();
    assert!(executor.events.iter().any(|event| event == "rollback"));
    assert!(!executor.events.iter().any(|event| event == "commit"));
    assert!(executor.history.entries.is_empty());
}

#[tokio::test]
async fn postcondition_failure_rolls_back_recorded_history() {
    let (_root, source) = fixture(&[("0000_first", "CREATE TABLE first_table (id integer);")]);
    let mut executor = FakeExecutor::new(false, HistorySnapshot::empty());
    executor.fail_postcondition = true;
    let mut runner = MigrationRunner::new(executor, MigrationRunnerConfig::default());

    let error = runner.run(request(source, None)).await.unwrap_err();
    assert_eq!(error.code(), "executor_error");
    assert!(error.receipt().unwrap().transaction.rolled_back);
    assert!(runner.executor().history.entries.is_empty());
}

#[tokio::test]
async fn dirty_reordered_history_fails_closed_inside_transaction() {
    let (_root, source) = fixture(&[("0000_first", "SELECT 1;"), ("0001_second", "SELECT 2;")]);
    let manifest = source.load().unwrap().manifest;
    let history = HistorySnapshot {
        table_exists: true,
        entries: vec![AppliedMigration {
            hash: Some(manifest.entries[1].sha256.clone()),
            name: Some(manifest.entries[1].file_name.clone()),
            created_at: Some(1),
        }],
    };
    let mut runner = MigrationRunner::new(
        FakeExecutor::new(false, history),
        MigrationRunnerConfig::default(),
    );

    let error = runner.run(request(source, None)).await.unwrap_err();
    assert_eq!(error.code(), "migration_history_dirty");
    assert!(error.receipt().unwrap().transaction.rolled_back);
    assert!(
        !runner
            .executor()
            .events
            .iter()
            .any(|event| event == "ensure_history_table")
    );
}

#[tokio::test]
async fn unknown_history_identifier_fails_closed_without_repair() {
    let (_root, source) = fixture(&[("0000_first", "SELECT 1;")]);
    let history = HistorySnapshot {
        table_exists: true,
        entries: vec![AppliedMigration {
            hash: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
            name: None,
            created_at: Some(1),
        }],
    };
    let mut runner = MigrationRunner::new(
        FakeExecutor::new(true, history),
        MigrationRunnerConfig::default(),
    );

    let error = runner
        .run(request(source, Some(valid_recovery())))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "migration_history_unknown");
    assert!(
        !runner
            .executor()
            .events
            .iter()
            .any(|event| event == "ensure_history_table")
    );
}

#[tokio::test]
async fn statement_size_limit_is_checked_before_sql_execution() {
    let (_root, source) = fixture(&[("0000_first", "SELECT 12345;")]);
    let config = MigrationRunnerConfig {
        max_statement_bytes: 4,
        ..MigrationRunnerConfig::default()
    };
    let mut runner =
        MigrationRunner::new(FakeExecutor::new(false, HistorySnapshot::empty()), config);

    let error = runner.run(request(source, None)).await.unwrap_err();
    assert_eq!(error.code(), "migration_statement_size_limit");
    assert!(error.receipt().unwrap().transaction.rolled_back);
    assert!(
        !runner
            .executor()
            .events
            .iter()
            .any(|event| event.starts_with("execute:"))
    );
}

#[tokio::test]
async fn baseline_compatibility_is_rechecked_after_transaction_begins() {
    let (_base_root, baseline) = fixture(&[("0000_first", "SELECT 1;")]);
    let (_candidate_root, candidate) = fixture(&[
        ("0000_first", "SELECT changed;"),
        ("0001_second", "SELECT 2;"),
    ]);
    let mut runner = MigrationRunner::new(
        FakeExecutor::new(false, HistorySnapshot::empty()),
        MigrationRunnerConfig::default(),
    );
    let error = runner
        .run(MigrationRunRequest {
            candidate,
            baseline: Some(baseline),
            recovery: None,
        })
        .await
        .unwrap_err();

    assert_eq!(error.code(), "migration_baseline_incompatible");
    assert!(error.receipt().unwrap().transaction.rolled_back);
    assert!(
        !runner
            .executor()
            .events
            .iter()
            .any(|event| event == "ensure_history_table")
    );
}

#[test]
fn source_loader_rejects_an_expected_fingerprint_mismatch() {
    let (_root, mut source) = fixture(&[("0000_first", "SELECT 1;")]);
    source.expected_fingerprint =
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into());
    let error = source.load().unwrap_err();
    assert_eq!(error.code(), "migration_fingerprint_mismatch");
}

#[tokio::test]
async fn history_name_and_hash_conflicts_fail_closed() {
    let (_root, source) = fixture(&[("0000_first", "SELECT 1;"), ("0001_second", "SELECT 2;")]);
    let manifest = source.load().unwrap().manifest;
    let history = HistorySnapshot {
        table_exists: true,
        entries: vec![AppliedMigration {
            hash: Some(manifest.entries[0].sha256.clone()),
            name: Some(manifest.entries[1].file_name.clone()),
            created_at: Some(1),
        }],
    };
    let mut runner = MigrationRunner::new(
        FakeExecutor::new(false, history),
        MigrationRunnerConfig::default(),
    );

    let error = runner.run(request(source, None)).await.unwrap_err();
    assert_eq!(error.code(), "migration_history_dirty");
    assert!(error.receipt().unwrap().transaction.rolled_back);
    assert!(
        !runner
            .executor()
            .events
            .iter()
            .any(|event| event == "ensure_history_table")
    );
}

#[tokio::test]
async fn extra_current_history_entry_fails_closed_without_index_panic() {
    let (_root, source) = fixture(&[("0000_first", "SELECT 1;")]);
    let manifest = source.load().unwrap().manifest;
    let row = AppliedMigration {
        hash: Some(manifest.entries[0].sha256.clone()),
        name: Some(manifest.entries[0].file_name.clone()),
        created_at: Some(1),
    };
    let mut runner = MigrationRunner::new(
        FakeExecutor::new(
            false,
            HistorySnapshot {
                table_exists: true,
                entries: vec![row.clone(), row],
            },
        ),
        MigrationRunnerConfig::default(),
    );

    let error = runner.run(request(source, None)).await.unwrap_err();
    assert_eq!(error.code(), "migration_history_dirty");
    assert!(error.receipt().unwrap().transaction.rolled_back);
}

#[test]
fn splits_only_the_drizzle_breakpoint_and_discards_empty_chunks() {
    assert_eq!(
        rudder_migration_runner::split_migration_statements(
            " SELECT 1; --> statement-breakpoint\n\n             SELECT 2; --> statement-breakpoint"
        ),
        vec!["SELECT 1;", "SELECT 2;"]
    );
}

#[allow(dead_code)]
fn _path_is_absolute(path: &Path) -> bool {
    path.is_absolute()
}

#[allow(dead_code)]
fn _path_buf(path: &Path) -> PathBuf {
    path.to_path_buf()
}
