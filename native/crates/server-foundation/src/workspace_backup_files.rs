use base64::Engine;
use rudder_archive_core::{
    ArchiveEntryInspection, ArchiveLimits, MANIFEST_PATH, inspect_manifest,
    inspect_manifest_reader, read_file as read_archive_file,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

const MAX_ARCHIVE_BYTES: u64 = 116 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 200_000;
const V2_POLICY_VERSION: &str = "workspace-backup-v2-policy-1";

#[derive(Debug, Deserialize)]
pub(crate) struct WorkspaceBackupFilesQuery {
    #[serde(default)]
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactIdentity {
    org_id: String,
    instance_id: String,
    root_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactEntry {
    path: String,
    kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Entry {
    path: String,
    kind: String,
    byte_size: u64,
    #[serde(default)]
    mtime_ms: Option<f64>,
    #[serde(default)]
    mode: Option<f64>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Manifest {
    version: u32,
    policy_version: String,
    identity: ArtifactIdentity,
    created_at: String,
    entries: Vec<V2Entry>,
    tree_sha256: String,
    warnings: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V1Artifact {
    version: u32,
    org_id: String,
    created_at: String,
    root_path: String,
    entries: Vec<V1ArtifactEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V1ArtifactEntry {
    path: String,
    kind: String,
    #[serde(default)]
    byte_size: Option<u64>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    data_base64: Option<String>,
    #[serde(default)]
    mtime_ms: Option<f64>,
}

pub(crate) enum DownloadArtifact {
    File {
        file: File,
        byte_size: u64,
        sha256: Option<String>,
    },
    Bytes {
        bytes: Vec<u8>,
        sha256: String,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileListReceipt {
    source: &'static str,
    root_path: String,
    repo_url: Option<String>,
    directory_path: String,
    root_exists: bool,
    entries: Vec<FileEntry>,
    message: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileReadReceipt {
    source: &'static str,
    root_path: String,
    repo_url: Option<String>,
    file_path: String,
    library_entry_id: Option<String>,
    mention_href: Option<String>,
    markdown_link: Option<String>,
    root_exists: bool,
    content: Option<String>,
    content_type: &'static str,
    preview_kind: &'static str,
    content_path: Option<String>,
    message: Option<&'static str>,
    truncated: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ArtifactError {
    NotFound,
    FileNotFound,
    Invalid,
    Cancelled,
}

pub(crate) fn normalize_directory_path(value: &str) -> Result<String, &'static str> {
    let normalized = value.trim().trim_matches('/');
    if normalized.split('/').any(|part| part == "..") {
        return Err("workspace_backup_path_invalid");
    }
    Ok(normalized.to_owned())
}

fn validate_entry_path(value: &str) -> Result<(), ArtifactError> {
    if value.is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.starts_with('/')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ArtifactError::Invalid);
    }
    Ok(())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, ArtifactError> {
    read_bounded_with_cancel(path, &AtomicBool::new(false))
}

fn read_bounded_with_cancel(path: &Path, cancelled: &AtomicBool) -> Result<Vec<u8>, ArtifactError> {
    let metadata = path.metadata().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ArtifactError::NotFound
        } else {
            ArtifactError::Invalid
        }
    })?;
    if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(ArtifactError::Invalid);
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| ArtifactError::Invalid)?;
    let mut file = File::open(path).map_err(|_| ArtifactError::Invalid)?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled.load(AtomicOrdering::Relaxed) {
            return Err(ArtifactError::Cancelled);
        }
        let read = file.read(&mut buffer).map_err(|_| ArtifactError::Invalid)?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > MAX_ARCHIVE_BYTES as usize {
            return Err(ArtifactError::Invalid);
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() as u64 != metadata.len() {
        return Err(ArtifactError::Invalid);
    }
    Ok(bytes)
}

fn verify_sha256(bytes: &[u8], expected: Option<&str>) -> Result<(), ArtifactError> {
    if expected.is_some_and(|expected| format!("{:x}", Sha256::digest(bytes)) != expected) {
        return Err(ArtifactError::Invalid);
    }
    Ok(())
}

fn verify_sha256_file(path: &Path, expected: Option<&str>) -> Result<(), ArtifactError> {
    let metadata = path.metadata().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ArtifactError::NotFound
        } else {
            ArtifactError::Invalid
        }
    })?;
    if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(ArtifactError::Invalid);
    }
    let mut file = File::open(path).map_err(|_| ArtifactError::Invalid)?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| ArtifactError::Invalid)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or(ArtifactError::Invalid)?;
        if total > MAX_ARCHIVE_BYTES {
            return Err(ArtifactError::Invalid);
        }
        hash.update(&buffer[..read]);
    }
    if total != metadata.len()
        || expected.is_some_and(|expected| format!("{:x}", hash.finalize()) != expected)
    {
        return Err(ArtifactError::Invalid);
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
}

fn fold_case(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
}

fn compare_js_strings(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn tree_sha256(entries: &[V2Entry]) -> String {
    let mut ordered: Vec<_> = entries.iter().collect();
    ordered.sort_by(|left, right| compare_js_strings(&left.path, &right.path));
    let mut hash = Sha256::new();
    for entry in ordered {
        hash.update(entry.path.as_bytes());
        hash.update(b"\0");
        hash.update(entry.kind.as_bytes());
        hash.update(b"\0");
        hash.update(entry.byte_size.to_string().as_bytes());
        hash.update(b"\0");
        hash.update(entry.sha256.as_deref().unwrap_or("").as_bytes());
        hash.update(b"\n");
    }
    format!("{:x}", hash.finalize())
}

fn root_segment(root_path: &str) -> String {
    let trimmed = root_path.trim_end_matches(['/', '\\']);
    let basename = trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("workspace");
    if basename.ends_with(':') {
        "workspace".to_owned()
    } else {
        basename.to_owned()
    }
}

fn validate_manifest(
    manifest: V2Manifest,
    archive_entries: &[ArchiveEntryInspection],
    org_id: &str,
) -> Result<Vec<ArtifactEntry>, ArtifactError> {
    if manifest.version != 2
        || manifest.policy_version != V2_POLICY_VERSION
        || manifest.identity.org_id != org_id
        || [
            &manifest.identity.org_id,
            &manifest.identity.instance_id,
            &manifest.identity.root_path,
        ]
        .iter()
        .any(|value| value.is_empty() || value.contains('\0'))
        || OffsetDateTime::parse(&manifest.created_at, &Rfc3339).is_err()
        || !is_sha256(&manifest.tree_sha256)
    {
        return Err(ArtifactError::Invalid);
    }
    let _warnings = manifest.warnings;

    let mut paths = HashSet::new();
    let mut folded_paths = HashSet::new();
    let mut total_file_bytes = 0u64;
    for entry in &manifest.entries {
        validate_entry_path(&entry.path)?;
        if entry.kind == "file" {
            total_file_bytes = total_file_bytes
                .checked_add(entry.byte_size)
                .ok_or(ArtifactError::Invalid)?;
        }
        if entry.byte_size > MAX_FILE_BYTES
            || total_file_bytes > MAX_TOTAL_FILE_BYTES
            || !paths.insert(entry.path.clone())
            || !folded_paths.insert(fold_case(&entry.path))
            || (entry.kind == "directory" && (entry.byte_size != 0 || entry.sha256.is_some()))
            || (entry.kind == "file"
                && entry
                    .sha256
                    .as_deref()
                    .is_none_or(|value| !is_sha256(value)))
            || (entry.kind != "directory" && entry.kind != "file")
            || entry.mtime_ms.is_some_and(|value| !value.is_finite())
            || entry.mode.is_some_and(|value| !value.is_finite())
        {
            return Err(ArtifactError::Invalid);
        }
    }
    if tree_sha256(&manifest.entries) != manifest.tree_sha256 {
        return Err(ArtifactError::Invalid);
    }

    let by_name: HashMap<_, _> = archive_entries
        .iter()
        .map(|entry| (entry.archive_path.as_str(), entry))
        .collect();
    let root = root_segment(&manifest.identity.root_path);
    if root.is_empty()
        || by_name
            .get(MANIFEST_PATH)
            .is_none_or(|entry| entry.is_directory)
        || by_name
            .get(format!("{root}/").as_str())
            .is_none_or(|entry| !entry.is_directory || entry.byte_size != 0)
    {
        return Err(ArtifactError::Invalid);
    }
    let mut expected = HashSet::from([MANIFEST_PATH.to_owned(), format!("{root}/")]);
    for entry in &manifest.entries {
        let archive_path = format!(
            "{root}/{}{}",
            entry.path,
            if entry.kind == "directory" { "/" } else { "" }
        );
        expected.insert(archive_path.clone());
        let Some(record) = by_name.get(archive_path.as_str()) else {
            return Err(ArtifactError::Invalid);
        };
        if record.is_directory != (entry.kind == "directory") || record.byte_size != entry.byte_size
        {
            return Err(ArtifactError::Invalid);
        }
    }
    if archive_entries.len() != expected.len()
        || archive_entries
            .iter()
            .any(|entry| !expected.contains(&entry.archive_path))
    {
        return Err(ArtifactError::Invalid);
    }

    Ok(manifest
        .entries
        .into_iter()
        .map(|entry| ArtifactEntry {
            path: entry.path,
            kind: entry.kind,
        })
        .collect())
}

fn validate_v1_entries(entries: &[V1ArtifactEntry]) -> Result<(), ArtifactError> {
    let mut paths = HashSet::new();
    let mut folded_paths = HashSet::new();
    let mut total_file_bytes = 0u64;
    for entry in entries {
        validate_entry_path(&entry.path)?;
        if entry.kind != "directory" && entry.kind != "file" {
            return Err(ArtifactError::Invalid);
        }
        if !paths.insert(entry.path.clone()) || !folded_paths.insert(fold_case(&entry.path)) {
            return Err(ArtifactError::Invalid);
        }
        if let Some(byte_size) = entry.byte_size {
            if byte_size > MAX_FILE_BYTES
                || (entry.kind == "directory" && byte_size != 0)
                || (entry.kind == "file"
                    && (total_file_bytes
                        .checked_add(byte_size)
                        .ok_or(ArtifactError::Invalid)?
                        > MAX_TOTAL_FILE_BYTES))
            {
                return Err(ArtifactError::Invalid);
            }
            if entry.kind == "file" {
                total_file_bytes = total_file_bytes
                    .checked_add(byte_size)
                    .ok_or(ArtifactError::Invalid)?;
            }
        }
        if entry
            .sha256
            .as_deref()
            .is_some_and(|value| !is_sha256(value))
        {
            return Err(ArtifactError::Invalid);
        }
    }
    Ok(())
}

fn load_v1_artifact(bytes: &[u8], org_id: &str) -> Result<V1Artifact, ArtifactError> {
    let artifact: V1Artifact = serde_json::from_slice(bytes).map_err(|_| ArtifactError::Invalid)?;
    if artifact.version != 1 || artifact.org_id != org_id {
        return Err(ArtifactError::Invalid);
    }
    validate_v1_entries(&artifact.entries)?;
    Ok(artifact)
}

fn legacy_download_root(artifact: &V1Artifact) -> String {
    let root = root_segment(&artifact.root_path);
    if root == "workspaces" {
        let storage_key = if artifact.org_id.len() == 36
            && artifact.org_id.bytes().enumerate().all(|(index, value)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    value == b'-'
                } else if index == 14 {
                    matches!(value, b'1'..=b'5')
                } else if index == 19 {
                    matches!(value.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
                } else {
                    value.is_ascii_hexdigit()
                }
            }) {
            artifact.org_id.replace('-', "")[..12].to_ascii_lowercase()
        } else {
            artifact.org_id.clone()
        };
        format!("workspace-{storage_key}")
    } else {
        root.replace(['/', '\\'], "-")
    }
}

fn zip_datetime(value: OffsetDateTime) -> zip::DateTime {
    zip_datetime_at_offset(
        value,
        UtcOffset::local_offset_at(value).unwrap_or(UtcOffset::UTC),
    )
}

fn zip_datetime_at_offset(value: OffsetDateTime, offset: UtcOffset) -> zip::DateTime {
    let local = value.to_offset(offset);
    zip::DateTime::from_date_and_time(
        local.year().clamp(1980, 2107) as u16,
        local.month() as u8,
        local.day(),
        local.hour(),
        local.minute(),
        local.second(),
    )
    .unwrap_or_default()
}

fn legacy_zip(artifact: &V1Artifact, cancelled: &AtomicBool) -> Result<Vec<u8>, ArtifactError> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let created_at = OffsetDateTime::parse(&artifact.created_at, &Rfc3339)
        .map_err(|_| ArtifactError::Invalid)?;
    let root_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .last_modified_time(zip_datetime(created_at));
    let root = legacy_download_root(artifact);
    writer
        .add_directory(format!("{root}/"), root_options)
        .map_err(|_| ArtifactError::Invalid)?;

    let mut entries: Vec<_> = artifact.entries.iter().collect();
    entries.sort_by(|left, right| compare_js_strings(&left.path, &right.path));
    for entry in entries {
        if cancelled.load(AtomicOrdering::Relaxed) {
            return Err(ArtifactError::Cancelled);
        }
        let archive_path = format!(
            "{root}/{}{}",
            entry.path,
            if entry.kind == "directory" { "/" } else { "" }
        );
        let modified_at = entry
            .mtime_ms
            .and_then(|value| {
                OffsetDateTime::from_unix_timestamp_nanos((value * 1_000_000.0) as i128).ok()
            })
            .unwrap_or(created_at);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .last_modified_time(zip_datetime(modified_at));
        if entry.kind == "directory" {
            writer
                .add_directory(archive_path, options)
                .map_err(|_| ArtifactError::Invalid)?;
            continue;
        }
        let data_base64 = entry.data_base64.as_deref().unwrap_or("");
        let max_base64_length = (MAX_FILE_BYTES as usize).div_ceil(3) * 4;
        if data_base64.len() > max_base64_length {
            return Err(ArtifactError::Invalid);
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|_| ArtifactError::Invalid)?;
        if data.len() as u64 > MAX_FILE_BYTES {
            return Err(ArtifactError::Invalid);
        }
        writer
            .start_file(archive_path, options)
            .map_err(|_| ArtifactError::Invalid)?;
        writer
            .write_all(&data)
            .map_err(|_| ArtifactError::Invalid)?;
    }
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|_| ArtifactError::Invalid)
}

pub(crate) fn prepare_download(
    path: &Path,
    org_id: &str,
    expected_sha256: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<DownloadArtifact, ArtifactError> {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        let mut file = File::open(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ArtifactError::NotFound
            } else {
                ArtifactError::Invalid
            }
        })?;
        let metadata = file.metadata().map_err(|_| ArtifactError::Invalid)?;
        if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
            return Err(ArtifactError::Invalid);
        }
        if let Some(expected) = expected_sha256 {
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if cancelled.load(AtomicOrdering::Relaxed) {
                    return Err(ArtifactError::Cancelled);
                }
                let read = file.read(&mut buffer).map_err(|_| ArtifactError::Invalid)?;
                if read == 0 {
                    break;
                }
                hash.update(&buffer[..read]);
            }
            if format!("{:x}", hash.finalize()) != expected {
                return Err(ArtifactError::Invalid);
            }
            file.seek(SeekFrom::Start(0))
                .map_err(|_| ArtifactError::Invalid)?;
        }
        let inspection = inspect_manifest_reader(
            &mut file,
            ArchiveLimits {
                max_archive_bytes: MAX_ARCHIVE_BYTES,
                max_manifest_bytes: MAX_MANIFEST_BYTES,
            },
        )
        .map_err(|_| ArtifactError::Invalid)?;
        let manifest_bytes = base64::engine::general_purpose::STANDARD
            .decode(inspection.manifest_base64)
            .map_err(|_| ArtifactError::Invalid)?;
        let manifest: V2Manifest =
            serde_json::from_slice(&manifest_bytes).map_err(|_| ArtifactError::Invalid)?;
        validate_manifest(manifest, &inspection.entries, org_id)?;
        file.seek(SeekFrom::Start(0))
            .map_err(|_| ArtifactError::Invalid)?;
        return Ok(DownloadArtifact::File {
            file,
            byte_size: metadata.len(),
            sha256: expected_sha256.map(str::to_owned),
        });
    }

    let bytes = read_bounded_with_cancel(path, cancelled)?;
    verify_sha256(&bytes, expected_sha256)?;
    let artifact = load_v1_artifact(&bytes, org_id)?;
    let bytes = legacy_zip(&artifact, cancelled)?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(DownloadArtifact::Bytes { bytes, sha256 })
}

pub(crate) fn load_entries(
    path: &Path,
    org_id: &str,
    expected_sha256: Option<&str>,
) -> Result<Vec<ArtifactEntry>, ArtifactError> {
    let bytes = read_bounded(path)?;
    verify_sha256(&bytes, expected_sha256)?;

    let entries = if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        let inspection = inspect_manifest(
            path,
            ArchiveLimits {
                max_archive_bytes: MAX_ARCHIVE_BYTES,
                max_manifest_bytes: MAX_MANIFEST_BYTES,
            },
        )
        .map_err(|_| ArtifactError::Invalid)?;
        let manifest_bytes = base64::engine::general_purpose::STANDARD
            .decode(inspection.manifest_base64)
            .map_err(|_| ArtifactError::Invalid)?;
        let manifest: V2Manifest =
            serde_json::from_slice(&manifest_bytes).map_err(|_| ArtifactError::Invalid)?;
        validate_manifest(manifest, &inspection.entries, org_id)?
    } else {
        let artifact = load_v1_artifact(&bytes, org_id)?;
        artifact
            .entries
            .into_iter()
            .map(|entry| ArtifactEntry {
                path: entry.path,
                kind: entry.kind,
            })
            .collect()
    };

    for entry in &entries {
        validate_entry_path(&entry.path)?;
        if entry.kind != "directory" && entry.kind != "file" {
            return Err(ArtifactError::Invalid);
        }
    }
    Ok(entries)
}

pub(crate) fn read_file(
    path: &Path,
    org_id: &str,
    expected_sha256: Option<&str>,
    file_path: &str,
) -> Result<Vec<u8>, ArtifactError> {
    let normalized_path =
        normalize_directory_path(file_path).map_err(|_| ArtifactError::Invalid)?;
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        verify_sha256_file(path, expected_sha256)?;
        let inspection = inspect_manifest(
            path,
            ArchiveLimits {
                max_archive_bytes: MAX_ARCHIVE_BYTES,
                max_manifest_bytes: MAX_MANIFEST_BYTES,
            },
        )
        .map_err(|_| ArtifactError::Invalid)?;
        let manifest_bytes = base64::engine::general_purpose::STANDARD
            .decode(inspection.manifest_base64)
            .map_err(|_| ArtifactError::Invalid)?;
        let manifest: V2Manifest =
            serde_json::from_slice(&manifest_bytes).map_err(|_| ArtifactError::Invalid)?;
        let root = root_segment(&manifest.identity.root_path);
        let target = manifest
            .entries
            .iter()
            .find(|entry| entry.path == normalized_path && entry.kind == "file")
            .cloned()
            .ok_or(ArtifactError::FileNotFound)?;
        validate_manifest(manifest, &inspection.entries, org_id)?;
        let archive_path = format!("{root}/{normalized_path}");
        let (bytes, extracted) =
            read_archive_file(path, &archive_path, MAX_ARCHIVE_BYTES, MAX_FILE_BYTES)
                .map_err(|_| ArtifactError::Invalid)?;
        if extracted.byte_size != target.byte_size
            || target.sha256.as_deref() != Some(extracted.sha256.as_str())
        {
            return Err(ArtifactError::Invalid);
        }
        return Ok(bytes);
    }

    let bytes = read_bounded(path)?;
    verify_sha256(&bytes, expected_sha256)?;
    let artifact = load_v1_artifact(&bytes, org_id)?;
    let target = artifact
        .entries
        .iter()
        .find(|entry| entry.path == normalized_path && entry.kind == "file")
        .ok_or(ArtifactError::FileNotFound)?;
    let Some(data_base64) = target
        .data_base64
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Err(ArtifactError::FileNotFound);
    };
    let max_base64_length = (MAX_FILE_BYTES as usize).div_ceil(3) * 4;
    if data_base64.len() > max_base64_length {
        return Err(ArtifactError::Invalid);
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| ArtifactError::Invalid)?;
    if data.len() as u64 > MAX_FILE_BYTES
        || target
            .byte_size
            .is_some_and(|size| size != data.len() as u64)
        || target
            .sha256
            .as_deref()
            .is_some_and(|sha256| format!("{:x}", Sha256::digest(&data)) != sha256)
    {
        return Err(ArtifactError::Invalid);
    }
    Ok(data)
}

fn direct_children(entries: &[ArtifactEntry], directory_path: &str) -> Vec<FileEntry> {
    let prefix = if directory_path.is_empty() {
        String::new()
    } else {
        format!("{directory_path}/")
    };
    let mut children = BTreeMap::<String, FileEntry>::new();
    for entry in entries {
        if !directory_path.is_empty() && entry.path == directory_path && entry.kind == "directory" {
            continue;
        }
        let Some(remainder) = entry.path.strip_prefix(&prefix) else {
            continue;
        };
        if remainder.is_empty() {
            continue;
        }
        let Some(name) = remainder.split('/').next().filter(|name| !name.is_empty()) else {
            continue;
        };
        let child_path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}{name}")
        };
        let is_directory = remainder.contains('/') || entry.kind == "directory";
        let child = FileEntry {
            name: name.to_owned(),
            path: child_path.clone(),
            is_directory,
        };
        match children.get(&child_path) {
            Some(existing) if existing.is_directory || !is_directory => {}
            _ => {
                children.insert(child_path, child);
            }
        }
    }
    let mut children: Vec<_> = children.into_values().collect();
    children.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| portable_filename_cmp(&left.name, &right.name))
    });
    children
}

fn portable_filename_cmp(left: &str, right: &str) -> Ordering {
    left.chars().cmp(right.chars())
}

pub(crate) fn file_list_receipt(
    entries: &[ArtifactEntry],
    directory_path: String,
    backup_id: &str,
) -> FileListReceipt {
    let entries = direct_children(entries, &directory_path);
    let message = entries.is_empty().then_some("This backup folder is empty.");
    FileListReceipt {
        source: "org_root",
        root_path: format!("backup:{backup_id}"),
        repo_url: None,
        directory_path,
        root_exists: true,
        entries,
        message,
    }
}

pub(crate) fn file_read_receipt(
    bytes: &[u8],
    file_path: String,
    backup_id: &str,
) -> FileReadReceipt {
    let binary = bytes.contains(&0);
    let (content, content_type, preview_kind, message, truncated) = if binary {
        (
            None,
            "application/octet-stream",
            "binary",
            Some("Binary files are not previewed in workspace backups."),
            false,
        )
    } else {
        let truncated = bytes.len() > MAX_PREVIEW_BYTES;
        let preview = &bytes[..bytes.len().min(MAX_PREVIEW_BYTES)];
        (
            Some(String::from_utf8_lossy(preview).into_owned()),
            "text/plain",
            "text",
            truncated.then_some("Preview truncated to the first 200 KB."),
            truncated,
        )
    };
    FileReadReceipt {
        source: "org_root",
        root_path: format!("backup:{backup_id}"),
        repo_url: None,
        file_path,
        library_entry_id: None,
        mention_href: None,
        markdown_link: None,
        root_exists: true,
        content,
        content_type,
        preview_kind,
        content_path: None,
        message,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const READ_PARITY_FIXTURE: &str =
        include_str!("../../../fixtures/workspace-backup-read-parity.json");

    #[test]
    fn children_match_node_directory_projection() {
        let entries = vec![
            ArtifactEntry {
                path: "root.txt".into(),
                kind: "file".into(),
            },
            ArtifactEntry {
                path: "docs".into(),
                kind: "directory".into(),
            },
            ArtifactEntry {
                path: "docs/zeta.txt".into(),
                kind: "file".into(),
            },
            ArtifactEntry {
                path: "nested/deep/file.txt".into(),
                kind: "file".into(),
            },
        ];
        assert_eq!(
            direct_children(&entries, ""),
            vec![
                FileEntry {
                    name: "docs".into(),
                    path: "docs".into(),
                    is_directory: true,
                },
                FileEntry {
                    name: "nested".into(),
                    path: "nested".into(),
                    is_directory: true,
                },
                FileEntry {
                    name: "root.txt".into(),
                    path: "root.txt".into(),
                    is_directory: false,
                },
            ]
        );
        assert_eq!(
            direct_children(&entries, "docs"),
            vec![FileEntry {
                name: "zeta.txt".into(),
                path: "docs/zeta.txt".into(),
                is_directory: false,
            }]
        );
    }

    #[test]
    fn filename_order_uses_portable_unicode_scalar_contract() {
        let fixture: serde_json::Value = serde_json::from_str(READ_PARITY_FIXTURE)
            .expect("workspace backup read parity fixture");
        let entries = fixture["ordering"]["input"]
            .as_array()
            .expect("ordering input")
            .iter()
            .map(|path| ArtifactEntry {
                path: path.as_str().expect("ordering filename").to_owned(),
                kind: "file".into(),
            })
            .collect::<Vec<_>>();
        let expected = fixture["ordering"]["expected"]
            .as_array()
            .expect("ordering expected")
            .iter()
            .map(|path| path.as_str().expect("expected filename").to_owned())
            .collect::<Vec<_>>();
        let actual = direct_children(&entries, "")
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }

    #[test]
    fn archive_root_uses_the_last_segment_across_platform_path_styles() {
        assert_eq!(root_segment("/fixture/workspace"), "workspace");
        assert_eq!(root_segment("/fixture/workspace/"), "workspace");
        assert_eq!(root_segment(r"C:\Users\Zeeland\workspace"), "workspace");
        assert_eq!(root_segment(r"C:\Users\Zeeland\workspace\"), "workspace");
        assert_eq!(root_segment(r"\\server\share\workspace"), "workspace");
        assert_eq!(root_segment("/"), "workspace");
        assert_eq!(root_segment(r"C:\"), "workspace");
    }

    #[cfg(unix)]
    #[test]
    fn v2_download_stream_keeps_the_validated_file_descriptor() {
        let root = tempfile::tempdir().expect("download fixture root");
        let source = root.path().join("root.txt");
        std::fs::write(&source, b"old").expect("write source");
        let file_sha256 = format!("{:x}", Sha256::digest(b"old"));
        let tree_sha256 = {
            let mut hash = Sha256::new();
            hash.update(b"root.txt");
            hash.update(b"\0");
            hash.update(b"file");
            hash.update(b"\0");
            hash.update(b"3");
            hash.update(b"\0");
            hash.update(file_sha256.as_bytes());
            hash.update(b"\n");
            format!("{:x}", hash.finalize())
        };
        let manifest_path = root.path().join("manifest.json");
        std::fs::write(
            &manifest_path,
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "policyVersion": V2_POLICY_VERSION,
                "identity": {
                    "orgId": "organization-1",
                    "instanceId": "test",
                    "rootPath": "/fixture/workspace"
                },
                "createdAt": "2026-09-04T00:00:00.000Z",
                "entries": [{
                    "path": "root.txt",
                    "kind": "file",
                    "byteSize": 3,
                    "mtimeMs": null,
                    "mode": null,
                    "sha256": file_sha256
                }],
                "treeSha256": tree_sha256,
                "warnings": []
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");
        let plan_path = root.path().join("plan.json");
        std::fs::write(
            &plan_path,
            serde_json::to_vec(&serde_json::json!({
                "protocolVersion": 1,
                "manifestSource": manifest_path,
                "treeSha256": tree_sha256,
                "entries": [
                    {"kind":"directory", "archivePath":"workspace/"},
                    {"kind":"file", "archivePath":"workspace/root.txt", "sourcePath":source}
                ]
            }))
            .expect("serialize plan"),
        )
        .expect("write plan");
        let archive_path = root.path().join("workspace.zip");
        let created = rudder_archive_core::create_archive(
            &plan_path,
            &archive_path,
            MAX_ARCHIVE_BYTES,
            MAX_FILE_BYTES,
            MAX_TOTAL_FILE_BYTES,
        )
        .expect("create archive");
        let expected = std::fs::read(&archive_path).expect("read original archive");
        let download = prepare_download(
            &archive_path,
            "organization-1",
            Some(&created.sha256),
            &AtomicBool::new(false),
        )
        .expect("prepare download");
        std::fs::rename(&archive_path, root.path().join("old.zip"))
            .expect("replace validated path");
        std::fs::write(&archive_path, b"replacement").expect("write replacement path");
        let DownloadArtifact::File { mut file, .. } = download else {
            panic!("expected file-backed download");
        };
        let mut actual = Vec::new();
        file.read_to_end(&mut actual).expect("read validated file");
        assert_eq!(actual, expected);
    }

    #[test]
    fn download_preflight_honors_cancellation_before_reading() {
        let root = tempfile::tempdir().expect("download fixture root");
        let artifact = root.path().join("workspace.json");
        std::fs::write(&artifact, b"{}").expect("write artifact");
        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            prepare_download(&artifact, "organization-1", None, &cancelled),
            Err(ArtifactError::Cancelled)
        ));
    }

    #[test]
    fn download_preflight_stops_after_cancellation_during_hashing() {
        let root = tempfile::tempdir().expect("download fixture root");
        let artifact = root.path().join("workspace.zip");
        std::fs::File::create(&artifact)
            .and_then(|file| file.set_len(MAX_ARCHIVE_BYTES))
            .expect("write bounded sparse archive");
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1));
            cancellation.store(true, AtomicOrdering::Relaxed);
        });
        let result = prepare_download(
            &artifact,
            "organization-1",
            Some(&"0".repeat(64)),
            &cancelled,
        );
        canceller.join().expect("join canceller");
        assert!(matches!(result, Err(ArtifactError::Cancelled)));
    }

    #[test]
    fn legacy_zip_dos_time_matches_shared_timezone_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(READ_PARITY_FIXTURE)
            .expect("workspace backup read parity fixture");
        let timestamp = OffsetDateTime::from_unix_timestamp_nanos(
            fixture["download"]["legacyMtimeMs"]
                .as_i64()
                .expect("legacy timestamp") as i128
                * 1_000_000,
        )
        .expect("legacy timestamp range");
        let utc = zip_datetime_at_offset(timestamp, UtcOffset::UTC);
        let asia_shanghai = zip_datetime_at_offset(
            timestamp,
            UtcOffset::from_hms(8, 0, 0).expect("Asia/Shanghai offset"),
        );
        assert_eq!(
            utc.hour(),
            fixture["download"]["utcHour"].as_u64().unwrap() as u8
        );
        assert_eq!(
            asia_shanghai.hour(),
            fixture["download"]["asiaShanghaiHour"].as_u64().unwrap() as u8
        );
    }

    #[test]
    fn preview_projection_uses_shared_limits_and_messages() {
        let fixture: serde_json::Value = serde_json::from_str(READ_PARITY_FIXTURE)
            .expect("workspace backup read parity fixture");
        let max_preview_bytes = fixture["limits"]["maxPreviewBytes"]
            .as_u64()
            .expect("max preview bytes") as usize;
        assert_eq!(
            MAX_ARCHIVE_BYTES,
            fixture["limits"]["maxArchiveBytes"]
                .as_u64()
                .expect("max archive bytes")
        );
        assert_eq!(
            MAX_MANIFEST_BYTES,
            fixture["limits"]["maxManifestBytes"]
                .as_u64()
                .expect("max manifest bytes")
        );
        assert_eq!(
            MAX_FILE_BYTES,
            fixture["limits"]["maxFileBytes"]
                .as_u64()
                .expect("max file bytes")
        );
        assert_eq!(
            MAX_TOTAL_FILE_BYTES,
            fixture["limits"]["maxTotalFileBytes"]
                .as_u64()
                .expect("max total file bytes")
        );
        assert_eq!(MAX_PREVIEW_BYTES, max_preview_bytes);

        let text = vec![b'a'; max_preview_bytes + 1];
        let text_receipt = file_read_receipt(&text, "large.txt".into(), "backup-1");
        assert_eq!(
            text_receipt.content.as_deref().map(str::len),
            Some(max_preview_bytes)
        );
        assert_eq!(
            text_receipt.content_type,
            fixture["preview"]["truncatedText"]["contentType"]
                .as_str()
                .expect("truncated content type")
        );
        assert_eq!(
            text_receipt.preview_kind,
            fixture["preview"]["truncatedText"]["previewKind"]
                .as_str()
                .expect("truncated preview kind")
        );
        assert_eq!(
            text_receipt.message,
            fixture["preview"]["truncatedText"]["message"]
                .as_str()
                .map(Some)
                .expect("truncated message")
        );
        assert_eq!(
            text_receipt.truncated,
            fixture["preview"]["truncatedText"]["truncated"]
                .as_bool()
                .expect("truncated flag")
        );

        let binary_receipt = file_read_receipt(b"prefix\0suffix", "data.bin".into(), "backup-1");
        assert_eq!(binary_receipt.content, None);
        assert_eq!(
            binary_receipt.content_type,
            fixture["preview"]["binary"]["contentType"]
                .as_str()
                .expect("binary content type")
        );
        assert_eq!(
            binary_receipt.preview_kind,
            fixture["preview"]["binary"]["previewKind"]
                .as_str()
                .expect("binary preview kind")
        );
        assert_eq!(
            binary_receipt.message,
            fixture["preview"]["binary"]["message"]
                .as_str()
                .map(Some)
                .expect("binary message")
        );
        assert_eq!(
            binary_receipt.truncated,
            fixture["preview"]["binary"]["truncated"]
                .as_bool()
                .expect("binary truncated flag")
        );
    }
}
