//! Durable transaction core for the separately installed macOS update helper.
//!
//! Desktop/CLI still own download, policy verification and extraction. This
//! process owns the destructive boundary after the application has quit.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const JOURNAL_VERSION: u32 = 1;
const DEFAULT_PROBATION_TIMEOUT_MS: u64 = 10_000;
static ATOMIC_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    pub operation: Operation,
    pub owner_token: String,
    /// Desktop's durable updateId. Optional for protocol-v1 compatibility;
    /// when supplied it is persisted and must match status/recover requests.
    #[serde(default)]
    pub transaction_id: Option<String>,
    #[serde(default)]
    pub parent_pid: Option<u32>,
    pub install_path: PathBuf,
    pub staged_path: PathBuf,
    pub lkg_path: PathBuf,
    pub journal_path: PathBuf,
    pub checkpoint_path: PathBuf,
    /// Desktop scheduler state to reconcile after a terminal commit.
    #[serde(default)]
    pub state_path: Option<PathBuf>,
    pub target_version: String,
    /// SHA-256 of a deterministic bundle manifest.
    pub candidate_sha256: String,
    pub admission: Admission,
    pub checkpoint: Checkpoint,
    pub helper: HelperIdentity,
    #[serde(default)]
    pub probation: Probation,
    #[serde(default)]
    pub fault: FaultInjection,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelperIdentity {
    pub path: PathBuf,
    pub owner_uid: u32,
    pub mode: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Apply,
    Recover,
    Status,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub closed: bool,
    pub active_runs: u32,
    pub drain_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub instance_id: String,
    pub database_revision: String,
    pub migration_compatible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Probation {
    pub executable: Option<PathBuf>,
    pub args: Vec<String>,
    pub timeout_ms: u64,
}

impl Default for Probation {
    fn default() -> Self {
        Self {
            executable: None,
            args: Vec::new(),
            timeout_ms: DEFAULT_PROBATION_TIMEOUT_MS,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct FaultInjection {
    pub fail_target_probe: bool,
    pub fail_lkg_probe: bool,
    pub fail_after_exchange_prepared: bool,
    pub fail_after_previous_moved: bool,
    pub fail_after_target_activated: bool,
    pub fail_after_probation_passed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    pub transaction_id: String,
    pub owner_token: String,
    pub target_version: String,
    pub install_path: PathBuf,
    pub staged_path: PathBuf,
    pub lkg_path: PathBuf,
    pub checkpoint_path: PathBuf,
    #[serde(default)]
    pub state_path: Option<PathBuf>,
    pub candidate_sha256: String,
    pub helper: HelperIdentity,
    pub admission: Admission,
    pub checkpoint: Checkpoint,
    pub stage: Stage,
    pub recovery_required: bool,
    pub recovery_code: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Prepared,
    AdmissionClosed,
    Checkpointed,
    ExchangePrepared,
    PreviousMoved,
    TargetActivated,
    ProbationPassed,
    Committed,
    RolledBack,
    RecoveryRequired,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelperResult {
    pub ok: bool,
    pub transaction_id: String,
    pub stage: Stage,
    pub rolled_back: bool,
    pub recovery_required: bool,
    pub recovery_code: Option<String>,
    pub message: String,
}

#[derive(Debug)]
pub enum HelperError {
    Invalid(String),
    Io(io::Error),
    Journal(String),
}

impl std::fmt::Display for HelperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid request: {message}"),
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Journal(message) => write!(f, "journal error: {message}"),
        }
    }
}

impl std::error::Error for HelperError {}

impl From<io::Error> for HelperError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn execute(request: &UpdateRequest) -> Result<HelperResult, HelperError> {
    validate_request(request)?;
    let lock_path = request.journal_path.with_extension("lock");
    let _lock = OwnershipFence::acquire(&lock_path, &request.owner_token)?;
    match request.operation {
        Operation::Status => status(request),
        Operation::Recover => recover(request),
        Operation::Apply => apply(request),
    }
}

fn validate_request(request: &UpdateRequest) -> Result<(), HelperError> {
    if request.owner_token.len() < 16 || request.owner_token.len() > 256 {
        return Err(HelperError::Invalid(
            "ownerToken must be 16..256 bytes".into(),
        ));
    }
    if let Some(transaction_id) = request.transaction_id.as_deref()
        && (transaction_id.len() < 8 || transaction_id.len() > 128)
    {
        return Err(HelperError::Invalid(
            "transactionId must be 8..128 bytes".into(),
        ));
    }
    if matches!(request.operation, Operation::Apply)
        && (request.target_version.trim().is_empty() || request.target_version.len() > 128)
    {
        return Err(HelperError::Invalid("targetVersion is required".into()));
    }
    if request.helper.path.is_relative()
        || request.helper.path.as_os_str().is_empty()
        || request.helper.mode != 0o755
        || request.helper.sha256.len() != 64
        || !request
            .helper
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(HelperError::Invalid("helper identity is incomplete".into()));
    }
    validate_helper_identity(&request.helper)?;
    if let Some(parent_pid) = request.parent_pid
        && parent_pid == 0
    {
        return Err(HelperError::Invalid("parentPid must be positive".into()));
    }
    if matches!(request.operation, Operation::Apply)
        && (request.candidate_sha256.len() != 64
            || !request
                .candidate_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(HelperError::Invalid(
            "candidateSha256 must be SHA-256 hex".into(),
        ));
    }
    for path in [
        &request.install_path,
        &request.staged_path,
        &request.lkg_path,
        &request.journal_path,
        &request.checkpoint_path,
    ] {
        if path.as_os_str().is_empty() || path.is_relative() {
            return Err(HelperError::Invalid(
                "install paths must be absolute".into(),
            ));
        }
        reject_symlink_chain(path)?;
        if path
            .components()
            .any(|component| component == Component::ParentDir)
        {
            return Err(HelperError::Invalid(
                "install paths must not contain parent traversal".into(),
            ));
        }
    }
    if let Some(state_path) = request.state_path.as_deref() {
        if state_path.as_os_str().is_empty()
            || state_path.is_relative()
            || state_path
                .components()
                .any(|component| component == Component::ParentDir)
        {
            return Err(HelperError::Invalid("statePath must be absolute".into()));
        }
        reject_symlink_chain(state_path)?;
        if state_path.exists() {
            reject_symlink(state_path)?;
            if !state_path.is_file() {
                return Err(HelperError::Invalid(
                    "statePath must be a regular file".into(),
                ));
            }
        }
    }
    if request.install_path == request.staged_path
        || request.install_path == request.lkg_path
        || request.staged_path == request.lkg_path
    {
        return Err(HelperError::Invalid(
            "install, staged, and LKG paths must differ".into(),
        ));
    }
    if matches!(request.operation, Operation::Apply) {
        if !request.admission.closed
            || request.admission.active_runs != 0
            || request.admission.drain_token.len() < 16
        {
            return Err(HelperError::Invalid(
                "instance admission is not closed and drained".into(),
            ));
        }
        if request.checkpoint.instance_id.trim().is_empty()
            || request.checkpoint.database_revision.trim().is_empty()
        {
            return Err(HelperError::Invalid(
                "checkpoint identity is incomplete".into(),
            ));
        }
        if !request.checkpoint.migration_compatible {
            return Err(HelperError::Invalid(
                "database migration compatibility gate failed".into(),
            ));
        }
    }
    if matches!(request.operation, Operation::Apply) && request.probation.executable.is_none() {
        return Err(HelperError::Invalid(
            "probation executable is required".into(),
        ));
    }
    if let Some(executable) = &request.probation.executable {
        let Some(relative) = executable.strip_prefix(&request.install_path).ok() else {
            return Err(HelperError::Invalid(
                "probation executable must be inside installPath".into(),
            ));
        };
        if executable.is_relative()
            || relative
                .components()
                .any(|component| component == Component::ParentDir)
            || relative
                .components()
                .any(|component| component == Component::RootDir)
        {
            return Err(HelperError::Invalid(
                "probation executable must be inside installPath".into(),
            ));
        }
        reject_symlink_chain(executable)?;
    }
    Ok(())
}

fn apply(request: &UpdateRequest) -> Result<HelperResult, HelperError> {
    if let Some(parent) = request.install_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = request.lkg_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let (staged_bundle, extraction_root) = materialize_staged_bundle(request)?;
    if !same_filesystem(request.install_path.parent(), staged_bundle.parent()) {
        if let Some(extraction_root) = extraction_root {
            let _ = fs::remove_dir_all(extraction_root);
        }
        return Err(HelperError::Invalid(
            "install and staged paths must share a filesystem for atomic exchange".into(),
        ));
    }

    let transaction_id = transaction_id(request);
    if let Some(parent_pid) = request.parent_pid
        && !wait_for_parent_exit(parent_pid)
    {
        return Err(HelperError::Invalid(
            "parent Desktop process did not exit before helper timeout".into(),
        ));
    }
    let mut journal = Journal {
        version: JOURNAL_VERSION,
        transaction_id: transaction_id.clone(),
        owner_token: request.owner_token.clone(),
        target_version: request.target_version.clone(),
        install_path: request.install_path.clone(),
        staged_path: request.staged_path.clone(),
        lkg_path: request.lkg_path.clone(),
        checkpoint_path: request.checkpoint_path.clone(),
        state_path: request.state_path.clone(),
        candidate_sha256: request.candidate_sha256.clone(),
        helper: request.helper.clone(),
        admission: request.admission.clone(),
        checkpoint: request.checkpoint.clone(),
        stage: Stage::Prepared,
        recovery_required: false,
        recovery_code: None,
        updated_at: now_string(),
    };
    write_journal(&request.journal_path, &journal)?;

    journal.stage = Stage::AdmissionClosed;
    write_journal(&request.journal_path, &journal)?;
    write_checkpoint(&request.checkpoint_path, request, &transaction_id)?;
    journal.stage = Stage::Checkpointed;
    write_journal(&request.journal_path, &journal)?;

    // Persist the recovery boundary before touching either generation. A
    // process kill after this point must be recoverable even if the next
    // journal write never happens.
    journal.stage = Stage::ExchangePrepared;
    journal.recovery_required = true;
    journal.recovery_code = Some("exchange_in_progress".into());
    write_journal(&request.journal_path, &journal)?;
    if request.fault.fail_after_exchange_prepared {
        return Err(HelperError::Io(io::Error::other(
            "fault after exchange prepared",
        )));
    }

    let retired_lkg_path = retired_lkg_path(request, &transaction_id);
    if retired_lkg_path.exists() {
        reject_symlink(&retired_lkg_path)?;
        if retired_lkg_path.is_dir() {
            fs::remove_dir_all(&retired_lkg_path)?;
        } else {
            fs::remove_file(&retired_lkg_path)?;
        }
    }

    if let Some(parent) = request.lkg_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = request.install_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if request.install_path.exists() {
        reject_symlink(&request.install_path)?;
        // The current install becomes the new LKG. A prior LKG is older than
        // that current install and can be retired before the exchange; the
        // current install remains available if the helper is interrupted here.
        if request.lkg_path.exists() {
            reject_symlink(&request.lkg_path)?;
            fs::rename(&request.lkg_path, &retired_lkg_path)?;
        }
        fs::rename(&request.install_path, &request.lkg_path)?;
    }
    journal.stage = Stage::PreviousMoved;
    write_journal(&request.journal_path, &journal)?;
    if request.fault.fail_after_previous_moved {
        journal.stage = Stage::RecoveryRequired;
        journal.recovery_required = true;
        journal.recovery_code = Some("interrupted_exchange".into());
        write_journal(&request.journal_path, &journal)?;
        return Err(HelperError::Io(io::Error::other(
            "fault after previous moved",
        )));
    }

    if let Err(error) = fs::rename(&staged_bundle, &request.install_path) {
        if let Some(extraction_root) = extraction_root {
            let _ = fs::remove_dir_all(extraction_root);
        }
        journal.stage = Stage::RecoveryRequired;
        journal.recovery_required = true;
        journal.recovery_code = Some("target_activation_failed".into());
        write_journal(&request.journal_path, &journal)?;
        return Err(error.into());
    }
    journal.stage = Stage::TargetActivated;
    write_journal(&request.journal_path, &journal)?;
    if request.fault.fail_after_target_activated {
        return Err(HelperError::Io(io::Error::other(
            "fault after target activated",
        )));
    }
    if !probe(request, &request.install_path, false) {
        let result = rollback(request, journal, "target_probe_failed");
        if let Some(extraction_root) = extraction_root {
            let _ = fs::remove_dir_all(extraction_root);
        }
        return result;
    }
    journal.stage = Stage::ProbationPassed;
    write_journal(&request.journal_path, &journal)?;
    if request.fault.fail_after_probation_passed {
        return Err(HelperError::Io(io::Error::other(
            "fault after probation passed",
        )));
    }
    journal.stage = Stage::Committed;
    journal.recovery_required = false;
    journal.recovery_code = None;
    write_journal(&request.journal_path, &journal)?;
    remove_retired_lkg(&retired_lkg_path)?;
    let _ = clear_desktop_candidate_state(request);
    if let Some(extraction_root) = extraction_root {
        let _ = fs::remove_dir_all(extraction_root);
    }
    Ok(HelperResult {
        ok: true,
        transaction_id,
        stage: Stage::Committed,
        rolled_back: false,
        recovery_required: false,
        recovery_code: None,
        message: "target activated and passed probation".into(),
    })
}

fn clear_desktop_candidate_state(request: &UpdateRequest) -> Result<(), HelperError> {
    let Some(state_path) = request.state_path.as_deref() else {
        return Ok(());
    };
    let bytes = match fs::read(state_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut state: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        HelperError::Journal(format!("automatic update state unreadable: {error}"))
    })?;
    let transaction_id = request.transaction_id.as_deref().unwrap_or_default();
    let candidate_matches = state
        .get("candidate")
        .and_then(|candidate| candidate.get("updateId"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|update_id| update_id == transaction_id);
    if !candidate_matches {
        return Ok(());
    }
    if let Some(object) = state.as_object_mut() {
        object.insert("candidate".into(), serde_json::Value::Null);
    }
    write_atomic_json(state_path, &state)
}

fn wait_for_parent_exit(parent_pid: u32) -> bool {
    for _ in 0..600 {
        #[cfg(unix)]
        {
            if unsafe { libc::kill(parent_pid as i32, 0) } != 0 {
                return true;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = parent_pid;
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn materialize_staged_bundle(
    request: &UpdateRequest,
) -> Result<(PathBuf, Option<PathBuf>), HelperError> {
    reject_symlink(&request.staged_path)?;
    if request.staged_path.is_dir() {
        ensure_directory(&request.staged_path)?;
        if bundle_manifest_digest(&request.staged_path)? != request.candidate_sha256 {
            return Err(HelperError::Invalid(
                "prepared bundle digest does not match candidateSha256".into(),
            ));
        }
        return Ok((request.staged_path.clone(), None));
    }
    if !request.staged_path.is_file() {
        return Err(HelperError::Invalid(
            "prepared artifact is neither an app bundle nor an archive".into(),
        ));
    }
    let mut file = File::open(&request.staged_path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if format!("{:x}", hasher.finalize()) != request.candidate_sha256.to_lowercase() {
        return Err(HelperError::Invalid(
            "prepared archive digest does not match candidateSha256".into(),
        ));
    }
    let extraction_root = request
        .install_path
        .parent()
        .unwrap_or_else(|| Path::new("/"))
        .join(format!(".rudder-helper-stage-{}", std::process::id()));
    if extraction_root.exists() {
        fs::remove_dir_all(&extraction_root)?;
    }
    fs::create_dir_all(&extraction_root)?;
    let status = Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(&request.staged_path)
        .arg(&extraction_root)
        .status()
        .map_err(HelperError::Io)?;
    if !status.success() {
        let _ = fs::remove_dir_all(&extraction_root);
        return Err(HelperError::Invalid(
            "failed to extract staged Desktop archive".into(),
        ));
    }
    let app = match fs::read_dir(&extraction_root)?
        .filter_map(Result::ok)
        .find(|entry| entry.path().extension().is_some_and(|ext| ext == "app"))
        .map(|entry| entry.path())
    {
        Some(app) => app,
        None => {
            let _ = fs::remove_dir_all(&extraction_root);
            return Err(HelperError::Invalid(
                "staged archive does not contain a .app bundle".into(),
            ));
        }
    };
    if let Err(error) = reject_symlink(&app).and_then(|_| {
        // Traversal rejects symlinked files/directories nested inside the
        // extracted bundle before any destructive rename occurs.
        bundle_manifest_digest(&app).map(|_| ())
    }) {
        let _ = fs::remove_dir_all(&extraction_root);
        return Err(error);
    }
    Ok((app, Some(extraction_root)))
}

fn same_filesystem(left: Option<&Path>, right: Option<&Path>) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let left_dev = fs::metadata(left).ok().map(|metadata| metadata.dev());
        let right_dev = fs::metadata(right).ok().map(|metadata| metadata.dev());
        left_dev.is_some() && left_dev == right_dev
    }
    #[cfg(not(unix))]
    {
        // The Windows packaged path uses one install root; directory exchange
        // is still guarded by the ownership fence and journal.
        true
    }
}

fn rollback(
    request: &UpdateRequest,
    mut journal: Journal,
    code: &str,
) -> Result<HelperResult, HelperError> {
    let failed_path = request
        .lkg_path
        .with_extension(format!("failed-{}", journal.transaction_id));
    if request.install_path.exists() {
        fs::rename(&request.install_path, &failed_path)?;
    }
    if !request.lkg_path.exists() || request.fault.fail_lkg_probe {
        journal.stage = Stage::RecoveryRequired;
        journal.recovery_required = true;
        journal.recovery_code = Some("dual_failure".into());
        write_journal(&request.journal_path, &journal)?;
        return Ok(HelperResult {
            ok: false,
            transaction_id: journal.transaction_id,
            stage: Stage::RecoveryRequired,
            rolled_back: false,
            recovery_required: true,
            recovery_code: Some("dual_failure".into()),
            message: "target failed probation and LKG is unavailable".into(),
        });
    }
    fs::rename(&request.lkg_path, &request.install_path)?;
    if !probe(request, &request.install_path, true) {
        // Preserve the failed previous generation at its durable recovery
        // location. The next helper invocation can retry or surface recovery
        // without losing the only rollback copy.
        let _ = fs::rename(&request.install_path, &request.lkg_path);
        journal.stage = Stage::RecoveryRequired;
        journal.recovery_required = true;
        journal.recovery_code = Some("dual_failure".into());
        write_journal(&request.journal_path, &journal)?;
        return Ok(HelperResult {
            ok: false,
            transaction_id: journal.transaction_id,
            stage: Stage::RecoveryRequired,
            rolled_back: false,
            recovery_required: true,
            recovery_code: Some("dual_failure".into()),
            message: "target and LKG failed probation".into(),
        });
    }
    journal.stage = Stage::RolledBack;
    journal.recovery_code = Some(code.into());
    write_journal(&request.journal_path, &journal)?;
    Ok(HelperResult {
        ok: false,
        transaction_id: journal.transaction_id,
        stage: Stage::RolledBack,
        rolled_back: true,
        recovery_required: false,
        recovery_code: Some(code.into()),
        message: "target failed probation; LKG restored".into(),
    })
}

fn retired_lkg_path(request: &UpdateRequest, transaction_id: &str) -> PathBuf {
    request
        .lkg_path
        .with_extension(format!("retired-{transaction_id}"))
}

fn remove_retired_lkg(path: &Path) -> Result<(), HelperError> {
    if !path.exists() {
        return Ok(());
    }
    reject_symlink(path)?;
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn recover(request: &UpdateRequest) -> Result<HelperResult, HelperError> {
    let journal = read_journal(&request.journal_path)?;
    if journal.owner_token != request.owner_token
        || journal.helper != request.helper
        || journal.install_path != request.install_path
        || journal.staged_path != request.staged_path
        || journal.lkg_path != request.lkg_path
        || journal.checkpoint_path != request.checkpoint_path
        || journal.state_path != request.state_path
        || journal.target_version != request.target_version
        || journal.candidate_sha256 != request.candidate_sha256
        || journal.admission != request.admission
        || journal.checkpoint != request.checkpoint
    {
        return Err(HelperError::Journal("journal owner fence mismatch".into()));
    }
    if request
        .transaction_id
        .as_deref()
        .is_some_and(|id| id != journal.transaction_id)
    {
        return Err(HelperError::Journal(
            "journal transaction fence mismatch".into(),
        ));
    }
    if !journal.recovery_required
        && !matches!(
            journal.stage,
            Stage::ExchangePrepared
                | Stage::PreviousMoved
                | Stage::TargetActivated
                | Stage::ProbationPassed
        )
    {
        return Ok(result_from_journal(&journal, "no recovery required"));
    }
    let retired_lkg = retired_lkg_path(request, &journal.transaction_id);
    if journal.stage == Stage::ExchangePrepared {
        // ExchangePrepared means the target has not been journaled as active.
        // Restore the previous generation whenever it is available; if the
        // current install is still present, it is already the safe generation.
        if !request.install_path.exists() && request.lkg_path.exists() {
            fs::rename(&request.lkg_path, &request.install_path)?;
        } else if request.install_path.exists() && request.lkg_path.exists() {
            // No exchange has been recorded yet. Both generations being
            // present means the original install is still the safe one; do
            // not downgrade it to an older LKG during recovery.
        } else if !request.install_path.exists() && retired_lkg.exists() {
            fs::rename(&retired_lkg, &request.install_path)?;
        }
    } else if !request.install_path.exists() && request.lkg_path.exists() {
        fs::rename(&request.lkg_path, &request.install_path)?;
    }
    if !request.install_path.exists() {
        let mut journal = journal;
        journal.stage = Stage::RecoveryRequired;
        journal.recovery_required = true;
        journal.recovery_code = Some("install_generation_missing".into());
        write_journal(&request.journal_path, &journal)?;
        return Ok(result_from_journal(
            &journal,
            "no recoverable install generation",
        ));
    }
    let target_stage = matches!(
        journal.stage,
        Stage::TargetActivated | Stage::ProbationPassed
    );
    if target_stage && probe(request, &request.install_path, false) {
        let mut journal = journal;
        journal.stage = Stage::Committed;
        journal.recovery_required = false;
        journal.recovery_code = None;
        write_journal(&request.journal_path, &journal)?;
        remove_retired_lkg(&retired_lkg)?;
        let _ = clear_desktop_candidate_state(request);
        return Ok(result_from_journal(&journal, "recovered activated target"));
    }
    if target_stage && request.install_path.exists() && request.lkg_path.exists() {
        let failed_path = request
            .lkg_path
            .with_extension(format!("failed-{}", journal.transaction_id));
        if failed_path.exists() {
            reject_symlink(&failed_path)?;
            if failed_path.is_dir() {
                fs::remove_dir_all(&failed_path)?;
            } else {
                fs::remove_file(&failed_path)?;
            }
        }
        fs::rename(&request.install_path, &failed_path)?;
        fs::rename(&request.lkg_path, &request.install_path)?;
    } else if !request.install_path.exists() && retired_lkg.exists() {
        fs::rename(&retired_lkg, &request.install_path)?;
    }
    if !probe(request, &request.install_path, true) {
        let mut journal = journal;
        journal.stage = Stage::RecoveryRequired;
        journal.recovery_required = true;
        journal.recovery_code = Some("lkg_recovery_probe_failed".into());
        write_journal(&request.journal_path, &journal)?;
        return Ok(result_from_journal(
            &journal,
            "last-known-good recovery probe failed",
        ));
    }
    let mut journal = journal;
    journal.stage = Stage::RolledBack;
    journal.recovery_required = false;
    journal.recovery_code = Some("recovered_previous_generation".into());
    write_journal(&request.journal_path, &journal)?;
    remove_retired_lkg(&retired_lkg)?;
    let _ = clear_desktop_candidate_state(request);
    Ok(result_from_journal(&journal, "recovery completed"))
}

fn status(request: &UpdateRequest) -> Result<HelperResult, HelperError> {
    let journal = read_journal(&request.journal_path)?;
    if journal.owner_token != request.owner_token
        || journal.helper != request.helper
        || journal.install_path != request.install_path
        || journal.staged_path != request.staged_path
        || journal.lkg_path != request.lkg_path
        || journal.checkpoint_path != request.checkpoint_path
        || journal.state_path != request.state_path
        || journal.target_version != request.target_version
        || journal.candidate_sha256 != request.candidate_sha256
        || journal.admission != request.admission
        || journal.checkpoint != request.checkpoint
    {
        return Err(HelperError::Journal("journal owner fence mismatch".into()));
    }
    if request
        .transaction_id
        .as_deref()
        .is_some_and(|id| id != journal.transaction_id)
    {
        return Err(HelperError::Journal(
            "journal transaction fence mismatch".into(),
        ));
    }
    Ok(result_from_journal(&journal, "journal status"))
}

fn validate_helper_identity(identity: &HelperIdentity) -> Result<(), HelperError> {
    reject_symlink_chain(&identity.path)?;
    let metadata = fs::symlink_metadata(&identity.path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HelperError::Invalid(
            "helper path is not a regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != identity.owner_uid
            || metadata.uid() != unsafe { libc::getuid() }
            || metadata.permissions().mode() & 0o7777 != 0o755
        {
            return Err(HelperError::Invalid("helper owner or mode mismatch".into()));
        }
    }
    let mut file = File::open(&identity.path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if format!("{:x}", hasher.finalize()) != identity.sha256.to_lowercase() {
        return Err(HelperError::Invalid("helper digest mismatch".into()));
    }
    Ok(())
}

fn result_from_journal(journal: &Journal, message: &str) -> HelperResult {
    HelperResult {
        ok: journal.stage == Stage::Committed,
        transaction_id: journal.transaction_id.clone(),
        stage: journal.stage,
        rolled_back: journal.stage == Stage::RolledBack,
        recovery_required: journal.recovery_required,
        recovery_code: journal.recovery_code.clone(),
        message: message.into(),
    }
}

fn probe(request: &UpdateRequest, install_path: &Path, lkg: bool) -> bool {
    if !install_path.is_dir() {
        return false;
    }
    if (lkg && request.fault.fail_lkg_probe) || (!lkg && request.fault.fail_target_probe) {
        return false;
    }
    let Some(executable) = request.probation.executable.as_ref() else {
        return true;
    };
    let relative = executable.strip_prefix(&request.install_path).ok();
    let Some(relative) = relative else {
        return false;
    };
    let executable = install_path.join(relative);
    let meta = match executable.symlink_metadata() {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
        _ => return false,
    };
    let _ = meta;
    let timeout = Duration::from_millis(request.probation.timeout_ms.max(1));
    let mut child = match Command::new(&executable)
        .args(&request.probation.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => return false,
        }
    }
}

fn ensure_directory(path: &Path) -> Result<(), HelperError> {
    if !path.is_dir() {
        return Err(HelperError::Invalid(format!(
            "bundle directory does not exist: {}",
            path.display()
        )));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), HelperError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(HelperError::Invalid(format!(
            "symlink path rejected: {}",
            path.display()
        )));
    }
    Ok(())
}

fn reject_symlink_chain(path: &Path) -> Result<(), HelperError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                // macOS exposes /var and /tmp as stable system aliases to
                // /private/*; these are not caller-controlled redirectors.
                if candidate == Path::new("/var") || candidate == Path::new("/tmp") {
                    current = candidate.parent();
                    continue;
                }
                return Err(HelperError::Invalid(format!(
                    "symlink path rejected: {}",
                    candidate.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        current = candidate.parent();
    }
    Ok(())
}

/// Computes the digest bound to an extracted App bundle. Symlink entries are
/// rejected so the receipt cannot be redirected outside the staged tree.
pub fn bundle_manifest_digest(root: &Path) -> Result<String, HelperError> {
    let mut entries = Vec::new();
    collect_entries(root, root, &mut entries)?;
    entries.sort();
    let mut hasher = Sha256::new();
    for (relative, digest, mode) in entries {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(digest.as_bytes());
        hasher.update([0]);
        hasher.update(mode.to_le_bytes());
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_entries(
    root: &Path,
    current: &Path,
    entries: &mut Vec<(String, String, u32)>,
) -> Result<(), HelperError> {
    let mut children =
        fs::read_dir(current).and_then(|iter| iter.collect::<Result<Vec<_>, _>>())?;
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(HelperError::Invalid(format!(
                "bundle contains symlink: {relative}"
            )));
        }
        if metadata.is_dir() {
            entries.push((format!("{relative}/"), "dir".into(), 0));
            collect_entries(root, &path, entries)?;
        } else if metadata.is_file() {
            let mut file = File::open(&path)?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            #[cfg(unix)]
            let mode = std::os::unix::fs::PermissionsExt::mode(&metadata.permissions());
            #[cfg(not(unix))]
            let mode = 0;
            entries.push((relative, format!("{:x}", hasher.finalize()), mode));
        }
    }
    Ok(())
}

fn write_checkpoint(
    path: &Path,
    request: &UpdateRequest,
    transaction_id: &str,
) -> Result<(), HelperError> {
    let payload = serde_json::json!({
        "version": 1,
        "transactionId": transaction_id,
        "instanceId": request.checkpoint.instance_id,
        "databaseRevision": request.checkpoint.database_revision,
        "migrationCompatible": request.checkpoint.migration_compatible,
        "admission": request.admission,
        "writtenAt": now_string(),
    });
    write_atomic_json(path, &payload)
}

fn write_journal(path: &Path, journal: &Journal) -> Result<(), HelperError> {
    let mut next = journal.clone();
    next.updated_at = now_string();
    write_atomic_json(path, &next)
}

fn read_journal(path: &Path) -> Result<Journal, HelperError> {
    let bytes = fs::read(path)?;
    let journal: Journal =
        serde_json::from_slice(&bytes).map_err(|error| HelperError::Journal(error.to_string()))?;
    if journal.version != JOURNAL_VERSION {
        return Err(HelperError::Journal("unsupported journal version".into()));
    }
    Ok(journal)
}

fn write_atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), HelperError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let sequence = ATOMIC_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("tmp-{}-{sequence}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| HelperError::Journal(error.to_string()))?;
    let mut file = File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    if let Some(parent) = path.parent()
        && let Ok(directory) = File::open(parent)
    {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn transaction_id(request: &UpdateRequest) -> String {
    if let Some(transaction_id) = request.transaction_id.as_deref() {
        return transaction_id.to_string();
    }
    let mut hasher = Sha256::new();
    hasher.update(request.owner_token.as_bytes());
    hasher.update(request.target_version.as_bytes());
    hasher.update(request.candidate_sha256.as_bytes());
    hasher.update(now_string().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..32].to_string()
}

fn now_string() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.to_string()
}

struct OwnershipFence {
    path: PathBuf,
}

impl OwnershipFence {
    fn acquire(path: &Path, owner_token: &str) -> Result<Self, HelperError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if !stale_owner_lock(path) {
                    return Err(HelperError::Invalid(
                        "another update helper owns this transaction".into(),
                    ));
                }
                fs::remove_file(path)?;
                OpenOptions::new().write(true).create_new(true).open(path)?
            }
            Err(error) => return Err(error.into()),
        };
        file.write_all(format!("pid={}\ntoken={}\n", std::process::id(), owner_token).as_bytes())?;
        file.sync_all()?;
        Ok(Self {
            path: path.to_path_buf(),
        })
    }
}

fn stale_owner_lock(path: &Path) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    let Some(pid) = contents
        .lines()
        .find_map(|line| line.strip_prefix("pid=")?.parse::<i32>().ok())
    else {
        return false;
    };
    #[cfg(unix)]
    {
        // kill(pid, 0) only probes process existence and does not signal it.
        // Permission failures are treated as live to preserve the fence.
        let result = unsafe { libc::kill(pid, 0) };
        result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

impl Drop for OwnershipFence {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_ROOT_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEMP_ROOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "rudder-update-helper-{label}-{}-{suffix}-{sequence}",
            std::process::id(),
        ));
        create_dir_all(&root).unwrap();
        root
    }

    fn make_bundle(path: &Path, succeeds: bool) -> String {
        let executable = path.join("Contents/MacOS/Rudder");
        create_dir_all(executable.parent().unwrap()).unwrap();
        write(
            &executable,
            if succeeds {
                "#!/bin/sh\nexit 0\n"
            } else {
                "#!/bin/sh\nexit 1\n"
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable, permissions).unwrap();
        }
        bundle_manifest_digest(path).unwrap()
    }

    fn request(root: &Path, digest: String) -> UpdateRequest {
        let helper_path = std::env::current_exe().unwrap();
        let helper_bytes = fs::read(&helper_path).unwrap();
        let helper_sha256 = format!("{:x}", Sha256::digest(helper_bytes));
        #[cfg(unix)]
        let helper_mode = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(&helper_path).unwrap().permissions().mode() & 0o7777
        };
        #[cfg(not(unix))]
        let helper_mode = 0o755;
        #[cfg(unix)]
        let helper_uid = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(&helper_path).unwrap().uid()
        };
        #[cfg(not(unix))]
        let helper_uid = 0;
        UpdateRequest {
            operation: Operation::Apply,
            owner_token: "owner-token-0123456789".into(),
            transaction_id: None,
            parent_pid: None,
            install_path: root.join("Rudder.app"),
            staged_path: root.join("staged/Rudder.app"),
            lkg_path: root.join("lkg/Rudder.app"),
            journal_path: root.join("journal.json"),
            checkpoint_path: root.join("checkpoint.json"),
            state_path: None,
            target_version: "0.7.5".into(),
            candidate_sha256: digest,
            admission: Admission {
                closed: true,
                active_runs: 0,
                drain_token: "drain-token-0123456789".into(),
            },
            checkpoint: Checkpoint {
                instance_id: "default".into(),
                database_revision: "db-rev-1".into(),
                migration_compatible: true,
            },
            helper: HelperIdentity {
                path: helper_path,
                owner_uid: helper_uid,
                mode: helper_mode,
                sha256: helper_sha256,
            },
            probation: Probation {
                executable: Some(root.join("Rudder.app/Contents/MacOS/Rudder")),
                args: vec![],
                timeout_ms: 5_000,
            },
            fault: FaultInjection::default(),
        }
    }

    #[test]
    fn successful_apply_persists_checkpoint_and_commits() {
        let root = temp_root("success");
        let install = root.join("Rudder.app");
        let staged = root.join("staged/Rudder.app");
        make_bundle(&install, true);
        let digest = make_bundle(&staged, true);
        let mut request = request(&root, digest);
        let result = execute(&request).unwrap();
        assert!(result.ok, "{result:?}");
        assert_eq!(result.stage, Stage::Committed);
        assert!(request.install_path.exists());
        assert!(request.lkg_path.exists());
        assert!(request.checkpoint_path.exists());
        request.operation = Operation::Status;
        assert_eq!(execute(&request).unwrap().stage, Stage::Committed);
    }

    #[test]
    fn supplied_transaction_id_is_persisted_and_fenced() {
        let root = temp_root("transaction-id");
        let install = root.join("Rudder.app");
        let staged = root.join("staged/Rudder.app");
        make_bundle(&install, true);
        let digest = make_bundle(&staged, true);
        let mut request = request(&root, digest);
        request.transaction_id = Some("desktop-update-123456".into());
        assert_eq!(
            execute(&request).unwrap().transaction_id,
            "desktop-update-123456"
        );
        request.operation = Operation::Status;
        assert!(execute(&request).is_ok());
        request.transaction_id = Some("desktop-update-other".into());
        assert!(execute(&request).is_err());
    }

    #[test]
    fn failed_target_probe_rolls_back_to_lkg() {
        let root = temp_root("rollback");
        let install = root.join("Rudder.app");
        let staged = root.join("staged/Rudder.app");
        make_bundle(&install, true);
        let digest = make_bundle(&staged, false);
        let request = request(&root, digest);
        let result = execute(&request).unwrap();
        assert!(!result.ok);
        assert!(result.rolled_back);
        assert!(request.install_path.exists());
        assert!(!result.recovery_required);
    }

    #[test]
    fn dual_failure_sets_recovery_required() {
        let root = temp_root("dual-failure");
        let install = root.join("Rudder.app");
        let staged = root.join("staged/Rudder.app");
        make_bundle(&install, true);
        let digest = make_bundle(&staged, false);
        let mut request = request(&root, digest);
        request.fault.fail_lkg_probe = true;
        let result = execute(&request).unwrap();
        assert!(!result.ok);
        assert!(result.recovery_required);
        assert_eq!(result.stage, Stage::RecoveryRequired);
        request.operation = Operation::Status;
        assert!(execute(&request).unwrap().recovery_required);
    }

    #[test]
    fn exchange_prepared_recovers_when_install_was_moved_before_next_journal_write() {
        let root = temp_root("exchange-prepared-recovery");
        let install = root.join("Rudder.app");
        let staged = root.join("staged/Rudder.app");
        make_bundle(&install, true);
        let digest = make_bundle(&staged, true);
        let mut request = request(&root, digest);
        request.fault.fail_after_exchange_prepared = true;
        assert!(execute(&request).is_err());

        // Model a process kill immediately after the old generation moved to
        // LKG but before the helper could advance the journal.
        fs::rename(&request.install_path, &request.lkg_path).unwrap();
        request.fault.fail_after_exchange_prepared = false;
        request.operation = Operation::Recover;
        let recovered = execute(&request).unwrap();
        assert_eq!(recovered.stage, Stage::RolledBack);
        assert!(!recovered.recovery_required);
        assert!(request.install_path.exists());
    }

    #[test]
    fn exchange_prepared_keeps_current_install_when_both_generations_exist() {
        let root = temp_root("exchange-prepared-both-present");
        let install = root.join("Rudder.app");
        let staged = root.join("staged/Rudder.app");
        make_bundle(&install, true);
        let digest = make_bundle(&staged, true);
        let mut request = request(&root, digest);
        request.fault.fail_after_exchange_prepared = true;
        assert!(execute(&request).is_err());
        // A kill before the first rename leaves both the current install and
        // the previous LKG present. Recovery must preserve the current one.
        make_bundle(&request.lkg_path, true);
        request.fault.fail_after_exchange_prepared = false;
        request.operation = Operation::Recover;
        let recovered = execute(&request).unwrap();
        assert_eq!(recovered.stage, Stage::RolledBack);
        assert!(request.install_path.exists());
    }

    #[test]
    fn target_activation_interruption_commits_or_rolls_back_idempotently() {
        for (label, succeeds, expected) in [
            ("target-live", true, Stage::Committed),
            ("target-dead", false, Stage::RolledBack),
        ] {
            let root = temp_root(label);
            let install = root.join("Rudder.app");
            let staged = root.join("staged/Rudder.app");
            make_bundle(&install, true);
            let digest = make_bundle(&staged, succeeds);
            let mut request = request(&root, digest);
            request.fault.fail_after_target_activated = true;
            assert!(execute(&request).is_err());
            request.fault.fail_after_target_activated = false;
            request.operation = Operation::Recover;
            let recovered = execute(&request).unwrap();
            assert_eq!(recovered.stage, expected);
            assert!(request.install_path.exists());
        }
    }

    #[test]
    fn probation_interruption_commits_healthy_target() {
        let root = temp_root("probation-interruption");
        let install = root.join("Rudder.app");
        let staged = root.join("staged/Rudder.app");
        make_bundle(&install, true);
        let digest = make_bundle(&staged, true);
        let mut request = request(&root, digest);
        request.fault.fail_after_probation_passed = true;
        assert!(execute(&request).is_err());
        request.fault.fail_after_probation_passed = false;
        request.operation = Operation::Recover;
        let recovered = execute(&request).unwrap();
        assert_eq!(recovered.stage, Stage::Committed);
        assert!(!recovered.recovery_required);
    }

    #[test]
    fn admission_and_migration_gates_fail_closed() {
        let root = temp_root("gates");
        let staged = root.join("staged/Rudder.app");
        let digest = make_bundle(&staged, true);
        let mut request = request(&root, digest);
        request.admission.active_runs = 1;
        assert!(execute(&request).is_err());
        request.admission.active_runs = 0;
        request.checkpoint.migration_compatible = false;
        assert!(execute(&request).is_err());
    }

    #[test]
    fn probation_executable_cannot_escape_install_bundle() {
        let root = temp_root("probation-traversal");
        let staged = root.join("staged/Rudder.app");
        let digest = make_bundle(&staged, true);
        let mut request = request(&root, digest);
        request.probation.executable =
            Some(request.install_path.join("Contents/MacOS/../outside-probe"));
        let error = execute(&request).expect_err("probation path traversal must fail closed");
        assert!(
            error
                .to_string()
                .contains("probation executable must be inside installPath")
        );
    }

    #[test]
    fn live_owner_fence_rejects_second_helper() {
        let root = temp_root("owner-fence");
        let lock = root.join("journal.lock");
        let first = OwnershipFence::acquire(&lock, "owner-token-0123456789").unwrap();
        assert!(OwnershipFence::acquire(&lock, "other-owner-token-012345").is_err());
        drop(first);
        assert!(OwnershipFence::acquire(&lock, "other-owner-token-012345").is_ok());
    }
}
