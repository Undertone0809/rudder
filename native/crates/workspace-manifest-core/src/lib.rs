//! Rebuildable workspace manifests backed by cross-platform file notifications.

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MANIFEST_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ManifestLimits {
    pub max_entries: u64,
    pub max_path_bytes: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManifestState {
    Building,
    Ready,
    Dirty,
    Overflow,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub path: String,
    pub kind: EntryKind,
    pub byte_size: u64,
    pub modified_millis: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceManifest {
    pub protocol_version: u32,
    pub state: ManifestState,
    pub root_path: PathBuf,
    pub generated_at_millis: u64,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestSummary {
    pub entry_count: usize,
    pub manifest_path: PathBuf,
    pub state: ManifestState,
}

#[derive(Debug)]
pub struct ManifestError {
    code: &'static str,
    accepted: bool,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl ManifestError {
    fn safe(code: &'static str) -> Self {
        Self {
            code,
            accepted: false,
            source: None,
        }
    }

    fn safe_source(
        code: &'static str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            accepted: false,
            source: Some(Box::new(source)),
        }
    }

    fn accepted_source(
        code: &'static str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            accepted: true,
            source: Some(Box::new(source)),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn accepted_operation(&self) -> bool {
        self.accepted
    }

    pub fn fallback_safe(&self) -> bool {
        !self.accepted
    }
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ManifestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|error| error.as_ref() as &(dyn std::error::Error + 'static))
    }
}

fn validate_limits(limits: ManifestLimits) -> Result<(), ManifestError> {
    if limits.max_entries == 0 || limits.max_path_bytes == 0 {
        return Err(ManifestError::safe("invalid_limit"));
    }
    Ok(())
}

fn portable_path(relative: &Path) -> Result<String, ManifestError> {
    let mut values = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| ManifestError::safe("non_utf8_workspace_path"))?;
                if value.contains('\0') {
                    return Err(ManifestError::safe("unsafe_workspace_path"));
                }
                values.push(value);
            }
            _ => return Err(ManifestError::safe("unsafe_workspace_path")),
        }
    }
    Ok(values.join("/"))
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn collect_entries(
    root: &Path,
    output: &Path,
    limits: ManifestLimits,
) -> Result<Vec<ManifestEntry>, ManifestError> {
    let mut entries = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut path_bytes = 0_u64;
    while let Some(directory) = pending.pop() {
        let mut children = fs::read_dir(&directory)
            .map_err(|error| ManifestError::safe_source("workspace_read_failed", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ManifestError::safe_source("workspace_read_failed", error))?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            if path == output || is_manifest_temp(&path, output) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| ManifestError::safe_source("workspace_metadata_failed", error))?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| ManifestError::safe("workspace_path_escape"))?;
            let portable = portable_path(relative)?;
            path_bytes = path_bytes
                .checked_add(portable.len() as u64)
                .ok_or_else(|| ManifestError::safe("manifest_path_limit"))?;
            if path_bytes > limits.max_path_bytes {
                return Err(ManifestError::safe("manifest_path_limit"));
            }
            if entries.len() as u64 >= limits.max_entries {
                return Err(ManifestError::safe("manifest_entry_limit"));
            }
            let kind = if metadata.file_type().is_symlink() {
                EntryKind::Symlink
            } else if metadata.is_dir() {
                EntryKind::Directory
            } else if metadata.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            entries.push(ManifestEntry {
                path: portable,
                kind,
                byte_size: if metadata.is_file() {
                    metadata.len()
                } else {
                    0
                },
                modified_millis: modified_millis(&metadata),
            });
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn is_manifest_temp(path: &Path, output: &Path) -> bool {
    let Some(parent) = output.parent() else {
        return false;
    };
    let Some(output_name) = output.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    path.parent() == Some(parent)
        && path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(&format!(".{output_name}.")))
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(unix)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both inputs are owned, NUL-terminated UTF-16 buffers that remain
    // alive for the duration of the Windows call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn build_manifest(
    root: &Path,
    output: &Path,
    limits: ManifestLimits,
) -> Result<ManifestSummary, ManifestError> {
    validate_limits(limits)?;
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| ManifestError::safe_source("workspace_metadata_failed", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ManifestError::safe("workspace_not_directory"));
    }
    let parent = output
        .parent()
        .ok_or_else(|| ManifestError::safe("manifest_parent_missing"))?;
    if !parent.is_dir() {
        return Err(ManifestError::safe("manifest_parent_unavailable"));
    }
    let entries = collect_entries(root, output, limits)?;
    let generated_at_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let manifest = WorkspaceManifest {
        protocol_version: MANIFEST_PROTOCOL_VERSION,
        state: ManifestState::Ready,
        root_path: root.to_path_buf(),
        generated_at_millis,
        entries,
    };
    let output_name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ManifestError::safe("manifest_name_invalid"))?;
    let temp = parent.join(format!(
        ".{output_name}.{}-{generated_at_millis}.tmp",
        std::process::id()
    ));
    let result = (|| -> Result<(), ManifestError> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| ManifestError::accepted_source("manifest_create_failed", error))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, &manifest)
            .map_err(|error| ManifestError::accepted_source("manifest_serialize_failed", error))?;
        writer
            .write_all(b"\n")
            .map_err(|error| ManifestError::accepted_source("manifest_write_failed", error))?;
        writer
            .flush()
            .map_err(|error| ManifestError::accepted_source("manifest_write_failed", error))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| ManifestError::accepted_source("manifest_sync_failed", error))?;
        atomic_replace(&temp, output)
            .map_err(|error| ManifestError::accepted_source("manifest_publish_failed", error))?;
        sync_directory(parent)
            .map_err(|error| ManifestError::accepted_source("manifest_sync_failed", error))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    Ok(ManifestSummary {
        entry_count: manifest.entries.len(),
        manifest_path: output.to_path_buf(),
        state: ManifestState::Ready,
    })
}

enum WatchSignal {
    Event(Event),
    Error,
}

#[derive(Clone, Copy, Debug, Default)]
struct EventBatch {
    dirty: bool,
    overflow: bool,
    disconnected: bool,
    stopped: bool,
}

fn relevant_event(event: &Event, output: &Path) -> bool {
    event
        .paths
        .iter()
        .any(|path| path != output && !is_manifest_temp(path, output))
}

fn collect_until_quiet(
    receiver: &Receiver<WatchSignal>,
    output: &Path,
    debounce: Duration,
    stop: Option<&Receiver<()>>,
) -> EventBatch {
    let mut batch = EventBatch::default();
    let mut deadline = std::time::Instant::now() + debounce;
    loop {
        if let Some(stop) = stop {
            match stop.try_recv() {
                Ok(()) | Err(TryRecvError::Disconnected) => {
                    batch.stopped = true;
                    return batch;
                }
                Err(TryRecvError::Empty) => {}
            }
        }
        let wait = deadline.saturating_duration_since(std::time::Instant::now());
        if wait.is_zero() {
            return batch;
        }
        match receiver.recv_timeout(wait.min(Duration::from_millis(50))) {
            Ok(WatchSignal::Event(event)) => {
                if relevant_event(&event, output) {
                    batch.dirty = true;
                    deadline = std::time::Instant::now() + debounce;
                }
            }
            Ok(WatchSignal::Error) => {
                batch.dirty = true;
                batch.overflow = true;
                deadline = std::time::Instant::now() + debounce;
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(stop) = stop {
                    match stop.try_recv() {
                        Ok(()) | Err(TryRecvError::Disconnected) => {
                            batch.stopped = true;
                        }
                        Err(TryRecvError::Empty) => {}
                    }
                }
                return batch;
            }
            Err(RecvTimeoutError::Disconnected) => {
                batch.disconnected = true;
                return batch;
            }
        }
    }
}

fn watch_disconnected() -> ManifestError {
    ManifestError::accepted_source(
        "watch_unavailable",
        io::Error::new(io::ErrorKind::BrokenPipe, "watch event channel closed"),
    )
}

fn rebuild_after_events<F>(
    overflow: bool,
    root: &Path,
    output: &Path,
    limits: ManifestLimits,
    summary: &mut ManifestSummary,
    emit: &mut F,
) -> Result<(), ManifestError>
where
    F: FnMut(ManifestState, Option<&ManifestSummary>),
{
    if overflow {
        emit(ManifestState::Overflow, Some(summary));
    }
    emit(ManifestState::Building, Some(summary));
    *summary = build_manifest(root, output, limits).map_err(|error| ManifestError {
        code: error.code,
        accepted: true,
        source: error.source,
    })?;
    emit(ManifestState::Ready, Some(summary));
    Ok(())
}

/// Watch a workspace until `stop` receives a value or is disconnected.
///
/// The manifest is rebuilt after a debounce window. Events arriving during a
/// rebuild remain queued and immediately dirty the new generation.
pub fn watch_workspace<F>(
    root: &Path,
    output: &Path,
    limits: ManifestLimits,
    debounce: Duration,
    stop: Receiver<()>,
    emit: F,
) -> Result<(), ManifestError>
where
    F: FnMut(ManifestState, Option<&ManifestSummary>),
{
    watch_workspace_inner(root, output, limits, debounce, stop, emit, || {})
}

fn watch_workspace_inner<F, H>(
    root: &Path,
    output: &Path,
    limits: ManifestLimits,
    debounce: Duration,
    stop: Receiver<()>,
    mut emit: F,
    after_initial_build: H,
) -> Result<(), ManifestError>
where
    F: FnMut(ManifestState, Option<&ManifestSummary>),
    H: FnOnce(),
{
    validate_limits(limits)?;
    if debounce.is_zero() || debounce > Duration::from_secs(60) {
        return Err(ManifestError::safe("invalid_debounce"));
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| ManifestError::safe_source("watch_unavailable", error))?;
    let output_parent = output
        .parent()
        .ok_or_else(|| ManifestError::safe("manifest_parent_missing"))?;
    let canonical_output_parent = fs::canonicalize(output_parent)
        .map_err(|error| ManifestError::safe_source("manifest_parent_unavailable", error))?;
    if canonical_output_parent.starts_with(&canonical_root) {
        return Err(ManifestError::safe("watch_output_inside_workspace"));
    }
    let (event_sender, event_receiver) = mpsc::channel();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |result| {
        let signal = match result {
            Ok(event) => WatchSignal::Event(event),
            Err(_) => WatchSignal::Error,
        };
        let _ = event_sender.send(signal);
    })
    .map_err(|error| ManifestError::safe_source("watch_unavailable", error))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|error| ManifestError::safe_source("watch_unavailable", error))?;

    emit(ManifestState::Building, None);
    let mut summary = build_manifest(root, output, limits)?;
    after_initial_build();
    loop {
        let batch = collect_until_quiet(&event_receiver, output, debounce, None);
        if batch.disconnected {
            emit(ManifestState::Unavailable, Some(&summary));
            return Err(watch_disconnected());
        }
        if batch.stopped {
            break;
        }
        if !batch.dirty {
            break;
        }
        if batch.overflow {
            emit(ManifestState::Overflow, Some(&summary));
        }
        summary = build_manifest(root, output, limits).map_err(|error| ManifestError {
            code: error.code,
            accepted: true,
            source: error.source,
        })?;
    }
    emit(ManifestState::Ready, Some(&summary));
    loop {
        match stop.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match event_receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(WatchSignal::Event(event)) if relevant_event(&event, output) => {
                emit(ManifestState::Dirty, Some(&summary));
                let batch = collect_until_quiet(&event_receiver, output, debounce, Some(&stop));
                if batch.disconnected {
                    emit(ManifestState::Unavailable, Some(&summary));
                    return Err(watch_disconnected());
                }
                if batch.stopped {
                    if batch.dirty {
                        rebuild_after_events(
                            batch.overflow,
                            root,
                            output,
                            limits,
                            &mut summary,
                            &mut emit,
                        )?;
                    }
                    return Ok(());
                }
                rebuild_after_events(
                    batch.overflow,
                    root,
                    output,
                    limits,
                    &mut summary,
                    &mut emit,
                )?;
            }
            Ok(WatchSignal::Event(_)) => {}
            Ok(WatchSignal::Error) => {
                let batch = collect_until_quiet(&event_receiver, output, debounce, Some(&stop));
                if batch.disconnected {
                    emit(ManifestState::Unavailable, Some(&summary));
                    return Err(watch_disconnected());
                }
                if batch.stopped {
                    if batch.dirty {
                        rebuild_after_events(true, root, output, limits, &mut summary, &mut emit)?;
                    }
                    return Ok(());
                }
                rebuild_after_events(true, root, output, limits, &mut summary, &mut emit)?;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                emit(ManifestState::Unavailable, Some(&summary));
                return Err(watch_disconnected());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use tempfile::tempdir;

    fn limits() -> ManifestLimits {
        ManifestLimits {
            max_entries: 10_000,
            max_path_bytes: 1024 * 1024,
        }
    }

    #[test]
    fn builds_stable_rebuildable_manifest_without_following_symlinks() {
        let outer = tempdir().unwrap();
        let root = outer.path().join("workspace");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("b")).unwrap();
        fs::write(root.join("b/file"), b"body").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outer.path(), root.join("outside-link")).unwrap();
        let output = root.join(".manifest.json");
        let first = build_manifest(&root, &output, limits()).unwrap();
        let parsed: WorkspaceManifest =
            serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        assert_eq!(first.entry_count, parsed.entries.len());
        assert_eq!(parsed.state, ManifestState::Ready);
        assert!(
            parsed
                .entries
                .windows(2)
                .all(|pair| pair[0].path < pair[1].path)
        );
        assert!(
            !parsed
                .entries
                .iter()
                .any(|entry| entry.path == ".manifest.json")
        );
        #[cfg(unix)]
        assert_eq!(
            parsed
                .entries
                .iter()
                .find(|entry| entry.path == "outside-link")
                .unwrap()
                .kind,
            EntryKind::Symlink
        );
        let second = build_manifest(&root, &output, limits()).unwrap();
        assert_eq!(first.entry_count, second.entry_count);
    }

    #[test]
    fn enforces_entry_and_path_limits_before_publication() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("file"), b"x").unwrap();
        let output = root.path().join("manifest.json");
        let error = build_manifest(
            root.path(),
            &output,
            ManifestLimits {
                max_entries: 1,
                max_path_bytes: 1,
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "manifest_path_limit");
        assert!(error.fallback_safe());
        assert!(!output.exists());
    }

    #[test]
    fn watches_create_delete_rename_storm_and_restarts_from_disk() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let output = outer.path().join("manifest.json");
        let root_path = workspace.clone();
        let output_path = output.clone();
        let (stop_sender, stop_receiver) = mpsc::channel();
        let states = Arc::new(Mutex::new(Vec::new()));
        let thread_states = Arc::clone(&states);
        let handle = thread::spawn(move || {
            watch_workspace(
                &root_path,
                &output_path,
                limits(),
                Duration::from_millis(50),
                stop_receiver,
                |state, _| thread_states.lock().unwrap().push(state),
            )
            .unwrap();
        });
        for _ in 0..100 {
            if states.lock().unwrap().contains(&ManifestState::Ready) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        for index in 0..40 {
            let first = workspace.join(format!("file-{index}"));
            let second = workspace.join(format!("renamed-{index}"));
            fs::write(&first, index.to_string()).unwrap();
            fs::rename(&first, &second).unwrap();
            if index % 2 == 0 {
                fs::remove_file(second).unwrap();
            }
        }
        for _ in 0..150 {
            if states
                .lock()
                .unwrap()
                .windows(2)
                .any(|pair| pair == [ManifestState::Building, ManifestState::Ready])
                && states.lock().unwrap().contains(&ManifestState::Dirty)
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        stop_sender.send(()).unwrap();
        handle.join().unwrap();
        let captured = states.lock().unwrap();
        assert!(captured.contains(&ManifestState::Dirty), "{captured:?}");
        assert_eq!(captured.last(), Some(&ManifestState::Ready));
        drop(captured);

        let rebuilt = build_manifest(&workspace, &output, limits()).unwrap();
        let parsed: WorkspaceManifest = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        assert_eq!(rebuilt.entry_count, parsed.entries.len());
        assert_eq!(
            parsed
                .entries
                .iter()
                .filter(|entry| entry.kind == EntryKind::File)
                .count(),
            20
        );
    }

    #[test]
    fn overflow_state_forces_a_rebuild_before_returning_ready() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("before"), b"before").unwrap();
        let output = root.path().join("manifest.json");
        let mut summary = build_manifest(root.path(), &output, limits()).unwrap();
        fs::remove_file(root.path().join("before")).unwrap();
        fs::write(root.path().join("after"), b"after").unwrap();
        let mut states = Vec::new();
        rebuild_after_events(
            true,
            root.path(),
            &output,
            limits(),
            &mut summary,
            &mut |state, _| states.push(state),
        )
        .unwrap();
        assert_eq!(
            states,
            [
                ManifestState::Overflow,
                ManifestState::Building,
                ManifestState::Ready
            ]
        );
        let parsed: WorkspaceManifest = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        assert!(parsed.entries.iter().any(|entry| entry.path == "after"));
        assert!(!parsed.entries.iter().any(|entry| entry.path == "before"));
    }

    #[test]
    fn unavailable_watch_root_is_safe_for_live_traversal_fallback() {
        let root = tempdir().unwrap();
        let missing = root.path().join("missing");
        let output = root.path().join("manifest.json");
        let (_stop_sender, stop_receiver) = mpsc::channel();
        let error = watch_workspace(
            &missing,
            &output,
            limits(),
            Duration::from_millis(10),
            stop_receiver,
            |_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.code(), "watch_unavailable");
        assert!(error.fallback_safe());
        assert!(!output.exists());
    }

    #[test]
    fn initial_scan_fence_rebuilds_queued_mutation_before_first_ready() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("before"), b"before").unwrap();
        let output = outer.path().join("manifest.json");
        let late = workspace.join("late");
        let (stop_sender, stop_receiver) = mpsc::channel();
        let mut states = Vec::new();
        watch_workspace_inner(
            &workspace,
            &output,
            limits(),
            Duration::from_millis(75),
            stop_receiver,
            |state, _| states.push(state),
            move || {
                fs::write(late, b"late").unwrap();
                stop_sender.send(()).unwrap();
            },
        )
        .unwrap();
        assert_eq!(states, [ManifestState::Building, ManifestState::Ready]);
        let parsed: WorkspaceManifest = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        assert!(parsed.entries.iter().any(|entry| entry.path == "late"));
    }

    #[test]
    fn observes_stop_arriving_during_debounce_wait() {
        let (_event_sender, event_receiver) = mpsc::channel();
        let (stop_sender, stop_receiver) = mpsc::channel();
        let stopper = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            stop_sender.send(()).unwrap();
        });

        let batch = collect_until_quiet(
            &event_receiver,
            Path::new("manifest.json"),
            Duration::from_millis(100),
            Some(&stop_receiver),
        );

        stopper.join().unwrap();
        assert!(batch.stopped);
        assert!(!batch.dirty);
    }
}
