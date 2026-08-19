//! Safe, bounded extraction and atomic publication for downloaded runtime payloads.

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

pub const PAYLOAD_PROTOCOL_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 200_000;
const MAX_VERSION_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveFormat {
    Auto,
    Zip,
    TarGz,
}

impl ArchiveFormat {
    pub fn parse(value: &str) -> Result<Self, PayloadError> {
        match value {
            "auto" => Ok(Self::Auto),
            "zip" => Ok(Self::Zip),
            "tar.gz" | "tgz" => Ok(Self::TarGz),
            _ => Err(PayloadError::safe("unsupported_archive_format")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtractLimits {
    pub max_archive_bytes: u64,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    pub strip_components: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedPayload {
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExtractedPayload {
    pub entry_count: usize,
    pub total_bytes: u64,
    pub staging_path: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub struct VersionProbe {
    pub version_output: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PublishedPayload {
    pub destination_path: PathBuf,
    pub recovered_previous: bool,
    pub already_published: bool,
}

#[derive(Debug)]
pub struct PayloadError {
    code: &'static str,
    accepted: bool,
    source: Option<io::Error>,
}

impl PayloadError {
    pub fn safe(code: &'static str) -> Self {
        Self {
            code,
            accepted: false,
            source: None,
        }
    }

    fn safe_io(code: &'static str, source: io::Error) -> Self {
        Self {
            code,
            accepted: false,
            source: Some(source),
        }
    }

    fn accepted(code: &'static str) -> Self {
        Self {
            code,
            accepted: true,
            source: None,
        }
    }

    fn accepted_io(code: &'static str, source: io::Error) -> Self {
        Self {
            code,
            accepted: true,
            source: Some(source),
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

impl std::fmt::Display for PayloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for PayloadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|error| error as _)
    }
}

fn validate_limits(limits: ExtractLimits) -> Result<(), PayloadError> {
    if limits.max_archive_bytes == 0 || limits.max_entry_bytes == 0 || limits.max_total_bytes == 0 {
        return Err(PayloadError::safe("invalid_limit"));
    }
    Ok(())
}

pub fn verify_payload(
    archive: &Path,
    expected_sha256: &str,
    max_archive_bytes: u64,
) -> Result<VerifiedPayload, PayloadError> {
    if max_archive_bytes == 0 {
        return Err(PayloadError::safe("invalid_limit"));
    }
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PayloadError::safe("invalid_expected_sha256"));
    }
    let metadata = fs::symlink_metadata(archive)
        .map_err(|error| PayloadError::safe_io("archive_metadata_failed", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PayloadError::safe("archive_not_regular_file"));
    }
    if metadata.len() > max_archive_bytes {
        return Err(PayloadError::safe("archive_size_limit"));
    }
    let mut input =
        File::open(archive).map_err(|error| PayloadError::safe_io("archive_open_failed", error))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut byte_size = 0_u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| PayloadError::safe_io("archive_read_failed", error))?;
        if read == 0 {
            break;
        }
        byte_size = byte_size
            .checked_add(read as u64)
            .ok_or_else(|| PayloadError::safe("archive_size_limit"))?;
        if byte_size > max_archive_bytes {
            return Err(PayloadError::safe("archive_size_limit"));
        }
        hash.update(&buffer[..read]);
    }
    let sha256 = format!("{:x}", hash.finalize());
    if !sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(PayloadError::safe("sha256_mismatch"));
    }
    Ok(VerifiedPayload { byte_size, sha256 })
}

fn detect_format(archive: &Path, requested: ArchiveFormat) -> Result<ArchiveFormat, PayloadError> {
    if requested != ArchiveFormat::Auto {
        return Ok(requested);
    }
    let mut input =
        File::open(archive).map_err(|error| PayloadError::safe_io("archive_open_failed", error))?;
    let mut magic = [0_u8; 4];
    let read = input
        .read(&mut magic)
        .map_err(|error| PayloadError::safe_io("archive_read_failed", error))?;
    if read >= 4 && matches!(magic, [0x50, 0x4b, 0x03, 0x04] | [0x50, 0x4b, 0x05, 0x06]) {
        Ok(ArchiveFormat::Zip)
    } else if read >= 2 && magic[..2] == [0x1f, 0x8b] {
        Ok(ArchiveFormat::TarGz)
    } else {
        Err(PayloadError::safe("unsupported_archive_format"))
    }
}

fn normalized_relative(path: &Path, strip: usize) -> Result<Option<PathBuf>, PayloadError> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| PayloadError::safe("non_utf8_entry_name"))?;
                if value.is_empty()
                    || value.contains('\0')
                    || value.contains('\\')
                    || value.contains(':')
                {
                    return Err(PayloadError::safe("unsafe_entry_name"));
                }
                components.push(value.to_owned());
            }
            _ => return Err(PayloadError::safe("unsafe_entry_name")),
        }
    }
    if components.len() <= strip {
        return Ok(None);
    }
    let mut output = PathBuf::new();
    for component in &components[strip..] {
        output.push(component);
    }
    Ok(Some(output))
}

#[derive(Clone, Debug)]
struct PlannedEntry {
    source_index: usize,
    path: PathBuf,
    directory: bool,
    size: u64,
    mode: u32,
}

fn register_entry(
    entries: &mut Vec<PlannedEntry>,
    names: &mut HashSet<String>,
    entry: PlannedEntry,
    limits: ExtractLimits,
    total: &mut u64,
) -> Result<(), PayloadError> {
    if entries.len() >= MAX_ENTRIES {
        return Err(PayloadError::safe("entry_count_limit"));
    }
    if entry.size > limits.max_entry_bytes {
        return Err(PayloadError::safe("entry_size_limit"));
    }
    *total = total
        .checked_add(entry.size)
        .ok_or_else(|| PayloadError::safe("total_size_limit"))?;
    if *total > limits.max_total_bytes {
        return Err(PayloadError::safe("total_size_limit"));
    }
    let portable = entry
        .path
        .iter()
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if !names.insert(portable.to_ascii_lowercase()) {
        return Err(PayloadError::safe("duplicate_entry_name"));
    }
    entries.push(entry);
    Ok(())
}

fn validate_entry_tree(entries: &[PlannedEntry]) -> Result<(), PayloadError> {
    let kinds = entries
        .iter()
        .map(|entry| {
            (
                entry
                    .path
                    .iter()
                    .map(|value| value.to_string_lossy().to_ascii_lowercase())
                    .collect::<Vec<_>>()
                    .join("/"),
                entry.directory,
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    for entry in entries {
        let components = entry
            .path
            .iter()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>();
        for length in 1..components.len() {
            let parent = components[..length].join("/");
            if kinds.get(&parent) == Some(&false) {
                return Err(PayloadError::safe("entry_path_conflict"));
            }
        }
    }
    Ok(())
}

fn preflight_zip(
    archive: &Path,
    limits: ExtractLimits,
) -> Result<(Vec<PlannedEntry>, u64), PayloadError> {
    let input =
        File::open(archive).map_err(|error| PayloadError::safe_io("archive_open_failed", error))?;
    let mut zip = zip::ZipArchive::new(input).map_err(|_| PayloadError::safe("invalid_zip"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(PayloadError::safe("entry_count_limit"));
    }
    let mut entries = Vec::with_capacity(zip.len());
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for index in 0..zip.len() {
        let file = zip
            .by_index(index)
            .map_err(|_| PayloadError::safe("invalid_zip"))?;
        let mode = file
            .unix_mode()
            .unwrap_or(if file.is_dir() { 0o040755 } else { 0o100644 });
        if file.encrypted()
            || !matches!(
                file.compression(),
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            )
        {
            return Err(PayloadError::safe("unsupported_entry_encoding"));
        }
        let kind = mode & 0o170000;
        if !matches!(kind, 0 | 0o040000 | 0o100000) {
            return Err(PayloadError::safe("special_entry_unsupported"));
        }
        let raw = Path::new(file.name());
        let Some(path) = normalized_relative(raw, limits.strip_components)? else {
            continue;
        };
        let directory = file.is_dir() || kind == 0o040000;
        register_entry(
            &mut entries,
            &mut names,
            PlannedEntry {
                source_index: index,
                path,
                directory,
                size: if directory { 0 } else { file.size() },
                mode,
            },
            limits,
            &mut total,
        )?;
    }
    validate_entry_tree(&entries)?;
    Ok((entries, total))
}

fn preflight_tar(
    archive: &Path,
    limits: ExtractLimits,
) -> Result<(Vec<PlannedEntry>, u64), PayloadError> {
    let input =
        File::open(archive).map_err(|error| PayloadError::safe_io("archive_open_failed", error))?;
    let decoder = GzDecoder::new(input);
    let mut tar = tar::Archive::new(decoder);
    let source_entries = tar
        .entries()
        .map_err(|error| PayloadError::safe_io("invalid_tar_gz", error))?;
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for (index, candidate) in source_entries.enumerate() {
        let candidate =
            candidate.map_err(|error| PayloadError::safe_io("invalid_tar_gz", error))?;
        let kind = candidate.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(PayloadError::safe("special_entry_unsupported"));
        }
        let raw = candidate
            .path()
            .map_err(|error| PayloadError::safe_io("invalid_tar_gz", error))?;
        let Some(path) = normalized_relative(&raw, limits.strip_components)? else {
            continue;
        };
        let size = if kind.is_file() {
            candidate
                .header()
                .size()
                .map_err(|error| PayloadError::safe_io("invalid_tar_gz", error))?
        } else {
            0
        };
        let mode = candidate
            .header()
            .mode()
            .map_err(|error| PayloadError::safe_io("invalid_tar_gz", error))?;
        register_entry(
            &mut entries,
            &mut names,
            PlannedEntry {
                source_index: index,
                path,
                directory: kind.is_dir(),
                size,
                mode,
            },
            limits,
            &mut total,
        )?;
    }
    validate_entry_tree(&entries)?;
    Ok((entries, total))
}

fn create_staging(staging: &Path) -> Result<(), PayloadError> {
    if staging.exists() {
        return Err(PayloadError::safe("staging_exists"));
    }
    let parent = staging
        .parent()
        .ok_or_else(|| PayloadError::safe("staging_parent_missing"))?;
    if !parent.is_dir() {
        return Err(PayloadError::safe("staging_parent_unavailable"));
    }
    fs::create_dir(staging)
        .map_err(|error| PayloadError::safe_io("staging_create_failed", error))?;
    Ok(())
}

fn open_output(root: &Path, relative: &Path) -> Result<File, PayloadError> {
    let output = root.join(relative);
    let parent = output
        .parent()
        .ok_or_else(|| PayloadError::accepted("unsafe_entry_name"))?;
    fs::create_dir_all(parent)
        .map_err(|error| PayloadError::accepted_io("entry_directory_create_failed", error))?;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output)
        .map_err(|error| PayloadError::accepted_io("entry_create_failed", error))
}

fn copy_bounded(
    input: &mut impl Read,
    output: &mut File,
    expected: u64,
) -> Result<(), PayloadError> {
    let copied = io::copy(&mut input.take(expected.saturating_add(1)), output)
        .map_err(|error| PayloadError::accepted_io("entry_write_failed", error))?;
    if copied != expected {
        return Err(PayloadError::accepted("entry_size_mismatch"));
    }
    output
        .sync_all()
        .map_err(|error| PayloadError::accepted_io("entry_sync_failed", error))
}

#[cfg(unix)]
fn apply_mode(path: &Path, mode: u32) -> Result<(), PayloadError> {
    use std::os::unix::fs::PermissionsExt;
    let safe_mode = mode & 0o777;
    fs::set_permissions(path, fs::Permissions::from_mode(safe_mode))
        .map_err(|error| PayloadError::accepted_io("entry_permissions_failed", error))
}

#[cfg(windows)]
fn apply_mode(_path: &Path, _mode: u32) -> Result<(), PayloadError> {
    Ok(())
}

fn extract_zip(
    archive: &Path,
    staging: &Path,
    entries: &[PlannedEntry],
) -> Result<(), PayloadError> {
    let input = File::open(archive)
        .map_err(|error| PayloadError::accepted_io("archive_open_failed", error))?;
    let mut zip = zip::ZipArchive::new(input).map_err(|_| PayloadError::accepted("invalid_zip"))?;
    for entry in entries {
        let mut source = zip
            .by_index(entry.source_index)
            .map_err(|_| PayloadError::accepted("invalid_zip"))?;
        if entry.directory {
            fs::create_dir_all(staging.join(&entry.path)).map_err(|error| {
                PayloadError::accepted_io("entry_directory_create_failed", error)
            })?;
        } else {
            let mut output = open_output(staging, &entry.path)?;
            copy_bounded(&mut source, &mut output, entry.size)?;
            apply_mode(&staging.join(&entry.path), entry.mode)?;
        }
    }
    Ok(())
}

fn extract_tar(
    archive: &Path,
    staging: &Path,
    entries: &[PlannedEntry],
) -> Result<(), PayloadError> {
    let input = File::open(archive)
        .map_err(|error| PayloadError::accepted_io("archive_open_failed", error))?;
    let decoder = GzDecoder::new(input);
    let mut tar = tar::Archive::new(decoder);
    let mut planned = entries.iter().peekable();
    for (index, candidate) in tar
        .entries()
        .map_err(|error| PayloadError::accepted_io("invalid_tar_gz", error))?
        .enumerate()
    {
        let mut candidate =
            candidate.map_err(|error| PayloadError::accepted_io("invalid_tar_gz", error))?;
        let Some(entry) = planned.peek() else {
            break;
        };
        if entry.source_index != index {
            continue;
        }
        if entry.directory {
            fs::create_dir_all(staging.join(&entry.path)).map_err(|error| {
                PayloadError::accepted_io("entry_directory_create_failed", error)
            })?;
        } else {
            let mut output = open_output(staging, &entry.path)?;
            copy_bounded(&mut candidate, &mut output, entry.size)?;
            apply_mode(&staging.join(&entry.path), entry.mode)?;
        }
        planned.next();
    }
    if planned.next().is_some() {
        return Err(PayloadError::accepted("archive_changed"));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn sync_tree(root: &Path) -> Result<(), PayloadError> {
    let mut directories = vec![root.to_path_buf()];
    let mut cursor = 0;
    while cursor < directories.len() {
        for entry in fs::read_dir(&directories[cursor])
            .map_err(|error| PayloadError::accepted_io("staging_read_failed", error))?
        {
            let entry =
                entry.map_err(|error| PayloadError::accepted_io("staging_read_failed", error))?;
            let metadata = entry
                .file_type()
                .map_err(|error| PayloadError::accepted_io("staging_read_failed", error))?;
            if metadata.is_dir() {
                directories.push(entry.path());
            }
        }
        cursor += 1;
    }
    for directory in directories.iter().rev() {
        sync_directory(directory)
            .map_err(|error| PayloadError::accepted_io("directory_sync_failed", error))?;
    }
    Ok(())
}

pub fn extract_payload(
    archive: &Path,
    requested_format: ArchiveFormat,
    staging: &Path,
    limits: ExtractLimits,
) -> Result<ExtractedPayload, PayloadError> {
    validate_limits(limits)?;
    let metadata = fs::symlink_metadata(archive)
        .map_err(|error| PayloadError::safe_io("archive_metadata_failed", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PayloadError::safe("archive_not_regular_file"));
    }
    if metadata.len() > limits.max_archive_bytes {
        return Err(PayloadError::safe("archive_size_limit"));
    }
    let format = detect_format(archive, requested_format)?;
    let (entries, total_bytes) = match format {
        ArchiveFormat::Zip => preflight_zip(archive, limits)?,
        ArchiveFormat::TarGz => preflight_tar(archive, limits)?,
        ArchiveFormat::Auto => unreachable!("auto is resolved above"),
    };
    create_staging(staging)?;
    let result = match format {
        ArchiveFormat::Zip => extract_zip(archive, staging, &entries),
        ArchiveFormat::TarGz => extract_tar(archive, staging, &entries),
        ArchiveFormat::Auto => unreachable!("auto is resolved above"),
    }
    .and_then(|()| sync_tree(staging));
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result?;
    Ok(ExtractedPayload {
        entry_count: entries.len(),
        total_bytes,
        staging_path: staging.to_path_buf(),
    })
}

pub fn probe_version(
    root: &Path,
    relative_executable: &Path,
    expected_fragment: &str,
) -> Result<VersionProbe, PayloadError> {
    if expected_fragment.is_empty() || expected_fragment.len() > 256 {
        return Err(PayloadError::accepted("invalid_expected_version"));
    }
    let relative = normalized_relative(relative_executable, 0)
        .map_err(|_| PayloadError::accepted("unsafe_executable_path"))?
        .ok_or_else(|| PayloadError::accepted("unsafe_executable_path"))?;
    let executable = root.join(relative);
    let metadata = fs::symlink_metadata(&executable)
        .map_err(|error| PayloadError::accepted_io("version_probe_metadata_failed", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PayloadError::accepted("version_probe_not_regular_file"));
    }
    let output = Command::new(&executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| PayloadError::accepted_io("version_probe_spawn_failed", error))?;
    if output.stdout.len().saturating_add(output.stderr.len()) > MAX_VERSION_BYTES {
        return Err(PayloadError::accepted("version_probe_output_limit"));
    }
    let version_output = String::from_utf8([output.stdout, output.stderr].concat())
        .map_err(|_| PayloadError::accepted("version_probe_non_utf8"))?
        .trim()
        .to_owned();
    if !output.status.success() {
        return Err(PayloadError::accepted("version_probe_nonzero"));
    }
    if !version_output.contains(expected_fragment) {
        return Err(PayloadError::accepted("version_mismatch"));
    }
    Ok(VersionProbe { version_output })
}

fn previous_path(destination: &Path) -> Result<PathBuf, PayloadError> {
    let parent = destination
        .parent()
        .ok_or_else(|| PayloadError::accepted("destination_parent_missing"))?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| PayloadError::accepted("destination_name_invalid"))?;
    Ok(parent.join(format!(".{name}.rudder-previous")))
}

fn rollback_previous(
    previous: &Path,
    destination: &Path,
    parent: &Path,
) -> Result<(), PayloadError> {
    if destination.exists() {
        return Err(PayloadError::accepted("publication_recovery_required"));
    }
    fs::rename(previous, destination)
        .map_err(|error| PayloadError::accepted_io("publication_recovery_required", error))?;
    sync_directory(parent)
        .map_err(|error| PayloadError::accepted_io("publication_recovery_required", error))
}

pub fn publish_payload(
    staging: &Path,
    destination: &Path,
) -> Result<PublishedPayload, PayloadError> {
    let parent = destination
        .parent()
        .ok_or_else(|| PayloadError::accepted("destination_parent_missing"))?;
    if !parent.is_dir() {
        return Err(PayloadError::accepted("destination_parent_unavailable"));
    }
    let previous = previous_path(destination)?;
    let mut recovered_previous = false;

    if !staging.exists() {
        if destination.is_dir() {
            if previous.exists() {
                fs::remove_dir_all(&previous)
                    .map_err(|error| PayloadError::accepted_io("previous_cleanup_failed", error))?;
                sync_directory(parent)
                    .map_err(|error| PayloadError::accepted_io("destination_sync_failed", error))?;
            }
            return Ok(PublishedPayload {
                destination_path: destination.to_path_buf(),
                recovered_previous,
                already_published: true,
            });
        }
        if previous.is_dir() {
            fs::rename(&previous, destination)
                .map_err(|error| PayloadError::accepted_io("previous_restore_failed", error))?;
            sync_directory(parent)
                .map_err(|error| PayloadError::accepted_io("destination_sync_failed", error))?;
            return Err(PayloadError::accepted("publication_recovered_previous"));
        }
        return Err(PayloadError::accepted("staging_missing"));
    }
    let staging_metadata = fs::symlink_metadata(staging)
        .map_err(|error| PayloadError::accepted_io("staging_metadata_failed", error))?;
    if staging_metadata.file_type().is_symlink() || !staging_metadata.is_dir() {
        return Err(PayloadError::accepted("staging_not_directory"));
    }
    if previous.exists() && destination.exists() {
        fs::remove_dir_all(&previous)
            .map_err(|error| PayloadError::accepted_io("previous_cleanup_failed", error))?;
    }
    if previous.exists() && !destination.exists() {
        recovered_previous = true;
    } else if destination.exists() {
        fs::rename(destination, &previous)
            .map_err(|error| PayloadError::accepted_io("previous_move_failed", error))?;
    }
    match fs::rename(staging, destination) {
        Ok(()) => {}
        Err(error) => {
            if previous.exists() && !destination.exists() {
                rollback_previous(&previous, destination, parent)?;
            }
            return Err(PayloadError::accepted_io(
                "publication_rename_failed",
                error,
            ));
        }
    }
    sync_directory(parent)
        .map_err(|error| PayloadError::accepted_io("destination_sync_failed", error))?;
    if previous.exists() {
        fs::remove_dir_all(&previous)
            .map_err(|error| PayloadError::accepted_io("previous_cleanup_failed", error))?;
        sync_directory(parent)
            .map_err(|error| PayloadError::accepted_io("destination_sync_failed", error))?;
    }
    Ok(PublishedPayload {
        destination_path: destination.to_path_buf(),
        recovered_previous,
        already_published: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (name, body) in entries {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
    }

    fn tar_fixture(path: &Path, name: &str, body: &[u8]) {
        let file = File::create(path).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, name, &mut Cursor::new(body))
            .unwrap();
        builder.finish().unwrap();
    }

    fn limits(strip_components: usize) -> ExtractLimits {
        ExtractLimits {
            max_archive_bytes: 1024 * 1024,
            max_entry_bytes: 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024,
            strip_components,
        }
    }

    #[test]
    fn verifies_digest_without_accepting_side_effects() {
        let root = tempdir().unwrap();
        let archive = root.path().join("payload.zip");
        fs::write(&archive, b"payload").unwrap();
        let expected = format!("{:x}", Sha256::digest(b"payload"));
        assert_eq!(
            verify_payload(&archive, &expected, 100).unwrap().byte_size,
            7
        );
        let error = verify_payload(&archive, &"0".repeat(64), 100).unwrap_err();
        assert_eq!(error.code(), "sha256_mismatch");
        assert!(error.fallback_safe());
    }

    #[test]
    fn extracts_zip_and_tar_gz_with_strip_and_bounds() {
        let root = tempdir().unwrap();
        let zip_path = root.path().join("payload.zip");
        zip_fixture(&zip_path, &[("root/bin/postgres", b"zip-body")]);
        let zip_out = root.path().join("zip-out");
        let result = extract_payload(&zip_path, ArchiveFormat::Auto, &zip_out, limits(1)).unwrap();
        assert_eq!(result.entry_count, 1);
        assert_eq!(fs::read(zip_out.join("bin/postgres")).unwrap(), b"zip-body");

        let tar_path = root.path().join("payload.tar.gz");
        tar_fixture(&tar_path, "root/bin/postgres", b"tar-body");
        let tar_out = root.path().join("tar-out");
        extract_payload(&tar_path, ArchiveFormat::Auto, &tar_out, limits(1)).unwrap();
        assert_eq!(fs::read(tar_out.join("bin/postgres")).unwrap(), b"tar-body");
    }

    #[test]
    fn rejects_traversal_and_partial_failure_never_allows_fallback() {
        let root = tempdir().unwrap();
        let archive = root.path().join("unsafe.zip");
        zip_fixture(&archive, &[("../outside", b"bad")]);
        let staging = root.path().join("staging");
        let error = extract_payload(&archive, ArchiveFormat::Zip, &staging, limits(0)).unwrap_err();
        assert_eq!(error.code(), "unsafe_entry_name");
        assert!(error.fallback_safe());
        assert!(!staging.exists());

        zip_fixture(&archive, &[("a", b"too large")]);
        let mut small = limits(0);
        small.max_entry_bytes = 1;
        let error = extract_payload(&archive, ArchiveFormat::Zip, &staging, small).unwrap_err();
        assert_eq!(error.code(), "entry_size_limit");
        assert!(error.fallback_safe());

        let archive = root.path().join("corrupt.zip");
        let body = b"unique-payload-body-for-corruption";
        zip_fixture(&archive, &[("first", body)]);
        let mut corrupt = fs::read(&archive).unwrap();
        let offset = corrupt
            .windows(body.len())
            .position(|candidate| candidate == body)
            .unwrap();
        corrupt[offset + body.len() / 2] ^= 0xff;
        fs::write(&archive, corrupt).unwrap();
        let staging = root.path().join("corrupt-staging");
        let error = extract_payload(&archive, ArchiveFormat::Zip, &staging, limits(0)).unwrap_err();
        assert!(!error.fallback_safe());
        assert!(!staging.exists());
    }

    #[test]
    fn publishes_recovers_interruption_and_is_repeatable() {
        let root = tempdir().unwrap();
        let destination = root.path().join("generation");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old"), b"old").unwrap();
        let staging = root.path().join("staging");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("new"), b"new").unwrap();

        let previous = root.path().join(".generation.rudder-previous");
        fs::rename(&destination, &previous).unwrap();
        assert!(!destination.exists());

        let published = publish_payload(&staging, &destination).unwrap();
        assert!(published.recovered_previous);
        assert_eq!(fs::read(destination.join("new")).unwrap(), b"new");
        let repeated = publish_payload(&staging, &destination).unwrap();
        assert!(repeated.already_published);
    }

    #[test]
    fn rollback_restores_once_or_reports_recovery_required_without_overwrite() {
        let root = tempdir().unwrap();
        let previous = root.path().join("previous");
        let destination = root.path().join("destination");
        fs::create_dir(&previous).unwrap();
        fs::write(previous.join("old"), b"old").unwrap();
        rollback_previous(&previous, &destination, root.path()).unwrap();
        assert_eq!(fs::read(destination.join("old")).unwrap(), b"old");
        assert!(!previous.exists());

        fs::create_dir(&previous).unwrap();
        fs::write(previous.join("older"), b"older").unwrap();
        let error = rollback_previous(&previous, &destination, root.path()).unwrap_err();
        assert_eq!(error.code(), "publication_recovery_required");
        assert!(!error.fallback_safe());
        assert!(previous.join("older").exists());
        assert!(destination.join("old").exists());
    }

    #[cfg(windows)]
    #[test]
    fn sharing_violation_preserves_both_generations_and_blocks_fallback() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, OPEN_EXISTING,
        };

        let root = tempdir().unwrap();
        let destination = root.path().join("generation");
        fs::create_dir(&destination).unwrap();
        let live_file = destination.join("live.bin");
        fs::write(&live_file, b"live").unwrap();
        let staging = root.path().join("staging");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("new.bin"), b"new").unwrap();
        let wide = live_file
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: the UTF-16 path is NUL-terminated and remains alive. A zero
        // share mask deliberately creates the Windows sharing violation.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_GENERIC_READ,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        let error = publish_payload(&staging, &destination).unwrap_err();
        // SAFETY: handle was returned by CreateFileW and has not been closed.
        unsafe { CloseHandle(handle) };
        assert_eq!(error.code(), "previous_move_failed");
        assert!(!error.fallback_safe());
        assert!(destination.join("live.bin").exists());
        assert!(staging.join("new.bin").exists());
    }

    #[cfg(unix)]
    #[test]
    fn probes_a_version_without_a_shell() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempdir().unwrap();
        let binary = root.path().join("postgres");
        fs::write(
            &binary,
            b"#!/bin/sh\nprintf 'postgres (PostgreSQL) 18.4\\n'\n",
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let result = probe_version(root.path(), Path::new("postgres"), "18.4").unwrap();
        assert!(result.version_output.contains("18.4"));
    }
}
