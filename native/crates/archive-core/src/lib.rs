use base64::Engine;
use crc32fast::Hasher as Crc32;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

pub const MANIFEST_PATH: &str = ".rudder-backup/manifest-v2.json";
pub const COPY_CHUNK_BYTES: usize = 64 * 1024;
const EOCD_FIXED_BYTES: usize = 22;
const CENTRAL_FIXED_BYTES: usize = 46;
const MAX_CENTRAL_BYTES: u64 = 8 * 1024 * 1024;
// Keep the public workspace fixture limit (10,000 files) usable when the
// archive also contains the manifest and directory entries.
const MAX_ENTRIES: usize = 16_384;
const MAX_NAME_BYTES: usize = 1024;
const MAX_AGGREGATE_NAME_BYTES: usize = 4 * 1024 * 1024;
pub const CREATE_PROTOCOL_VERSION: u32 = 1;
pub const MAX_CREATE_PLAN_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct ArchiveLimits {
    pub max_archive_bytes: u64,
    pub max_manifest_bytes: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ManifestInspection {
    pub manifest_base64: String,
    pub byte_size: u64,
    pub sha256: String,
    pub entry_count: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExtractedFile {
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePlan {
    pub protocol_version: u32,
    pub manifest_source: std::path::PathBuf,
    pub tree_sha256: String,
    pub entries: Vec<CreateEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum CreateEntry {
    File {
        #[serde(rename = "archivePath")]
        archive_path: String,
        #[serde(rename = "sourcePath")]
        source_path: std::path::PathBuf,
    },
    Directory {
        #[serde(rename = "archivePath")]
        archive_path: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct CreatedArchive {
    pub byte_size: u64,
    pub sha256: String,
    pub manifest_sha256: String,
    pub tree_sha256: String,
    pub entry_count: usize,
}

#[derive(Debug)]
pub struct ArchiveError {
    code: &'static str,
    source: Option<io::Error>,
}

impl ArchiveError {
    fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    fn io(code: &'static str, source: io::Error) -> Self {
        Self {
            code,
            source: Some(source),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ArchiveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|error| error as _)
    }
}

#[derive(Clone, Debug)]
struct CentralEntry {
    name: String,
    flags: u16,
    method: u16,
    crc32: u32,
    compressed_size: u32,
    size: u32,
    local_header_offset: u32,
}

struct ValidatedArchive<R> {
    reader: R,
    entries: Vec<CentralEntry>,
}

struct Preflight {
    entries: Vec<CentralEntry>,
    central_offset: u64,
}

fn u16_at(value: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([value[offset], value[offset + 1]])
}

fn u32_at(value: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        value[offset],
        value[offset + 1],
        value[offset + 2],
        value[offset + 3],
    ])
}

fn validate_name(raw: &[u8], directory: bool) -> Result<String, ArchiveError> {
    if raw.is_empty() || raw.len() > MAX_NAME_BYTES || raw.contains(&0) || raw.contains(&b'\\') {
        return Err(ArchiveError::new("unsafe_entry_name"));
    }
    let name = std::str::from_utf8(raw).map_err(|_| ArchiveError::new("non_utf8_entry_name"))?;
    if name.starts_with('/')
        || name.starts_with("//")
        || name.get(1..2) == Some(":")
        || directory != name.ends_with('/')
    {
        return Err(ArchiveError::new("unsafe_entry_name"));
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if trimmed.is_empty()
        || trimmed
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ArchiveError::new("unsafe_entry_name"));
    }
    Ok(name.to_owned())
}

fn find_eocd<R: Read + Seek>(
    reader: &mut R,
    archive_len: u64,
) -> Result<(u64, Vec<u8>), ArchiveError> {
    let offset = archive_len - EOCD_FIXED_BYTES as u64;
    let mut fixed = [0u8; EOCD_FIXED_BYTES];
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|error| ArchiveError::io("archive_read_failed", error))?;
    reader
        .read_exact(&mut fixed)
        .map_err(|error| ArchiveError::io("archive_read_failed", error))?;
    if fixed[..4] == [0x50, 0x4b, 0x05, 0x06] && u16_at(&fixed, 20) == 0 {
        return Ok((offset, fixed.to_vec()));
    }
    Err(ArchiveError::new("invalid_eocd"))
}

fn preflight<R: Read + Seek>(
    reader: &mut R,
    max_archive_bytes: u64,
) -> Result<Preflight, ArchiveError> {
    let archive_len = reader
        .seek(SeekFrom::End(0))
        .map_err(|error| ArchiveError::io("archive_read_failed", error))?;
    if archive_len < EOCD_FIXED_BYTES as u64 || archive_len > max_archive_bytes {
        return Err(ArchiveError::new("archive_size_limit"));
    }
    let (eocd_offset, eocd) = find_eocd(reader, archive_len)?;
    let disk = u16_at(&eocd, 4);
    let central_disk = u16_at(&eocd, 6);
    let disk_entries = u16_at(&eocd, 8);
    let total_entries = u16_at(&eocd, 10);
    let central_size = u32_at(&eocd, 12);
    let central_offset = u32_at(&eocd, 16);
    if total_entries == u16::MAX || central_size == u32::MAX || central_offset == u32::MAX {
        return Err(ArchiveError::new("zip64_unsupported"));
    }
    if disk != 0 || central_disk != 0 || disk_entries != total_entries {
        return Err(ArchiveError::new("multi_disk_unsupported"));
    }
    if total_entries as usize > MAX_ENTRIES || central_size as u64 > MAX_CENTRAL_BYTES {
        return Err(ArchiveError::new("central_directory_limit"));
    }
    if central_offset as u64 + central_size as u64 != eocd_offset {
        return Err(ArchiveError::new("invalid_central_directory"));
    }
    reader
        .seek(SeekFrom::Start(central_offset as u64))
        .map_err(|error| ArchiveError::io("archive_read_failed", error))?;
    let mut central = vec![0; central_size as usize];
    reader
        .read_exact(&mut central)
        .map_err(|error| ArchiveError::io("archive_read_failed", error))?;
    let mut entries = Vec::with_capacity(total_entries as usize);
    let mut exact_names = HashSet::new();
    let mut folded_names = HashSet::new();
    let mut aggregate_name_bytes = 0usize;
    let mut cursor = 0usize;
    while cursor < central.len() {
        if central.len() - cursor < CENTRAL_FIXED_BYTES
            || central[cursor..cursor + 4] != [0x50, 0x4b, 0x01, 0x02]
        {
            return Err(ArchiveError::new("invalid_central_directory"));
        }
        let made_by = u16_at(&central, cursor + 4);
        let flags = u16_at(&central, cursor + 8);
        let method = u16_at(&central, cursor + 10);
        let crc32 = u32_at(&central, cursor + 16);
        let compressed_size = u32_at(&central, cursor + 20);
        let size = u32_at(&central, cursor + 24);
        let name_len = u16_at(&central, cursor + 28) as usize;
        let extra_len = u16_at(&central, cursor + 30) as usize;
        let comment_len = u16_at(&central, cursor + 32) as usize;
        let disk_start = u16_at(&central, cursor + 34);
        let external_attributes = u32_at(&central, cursor + 38);
        let local_header_offset = u32_at(&central, cursor + 42);
        let record_len = CENTRAL_FIXED_BYTES
            .checked_add(name_len)
            .and_then(|value| value.checked_add(extra_len))
            .and_then(|value| value.checked_add(comment_len))
            .ok_or_else(|| ArchiveError::new("central_directory_limit"))?;
        if cursor + record_len > central.len() || name_len > MAX_NAME_BYTES {
            return Err(ArchiveError::new("central_directory_limit"));
        }
        aggregate_name_bytes = aggregate_name_bytes
            .checked_add(name_len)
            .ok_or_else(|| ArchiveError::new("central_directory_limit"))?;
        if aggregate_name_bytes > MAX_AGGREGATE_NAME_BYTES {
            return Err(ArchiveError::new("central_directory_limit"));
        }
        if disk_start != 0 || flags & 0x0001 != 0 {
            return Err(ArchiveError::new(if disk_start != 0 {
                "multi_disk_unsupported"
            } else {
                "encrypted_entry_unsupported"
            }));
        }
        if flags != 0x0800 || method != 0 || compressed_size != size {
            return Err(ArchiveError::new("unsupported_entry_encoding"));
        }
        let raw_name =
            &central[cursor + CENTRAL_FIXED_BYTES..cursor + CENTRAL_FIXED_BYTES + name_len];
        let creator_system = made_by >> 8;
        if creator_system != 0 || extra_len != 0 || external_attributes & !0x10 != 0 {
            return Err(ArchiveError::new(if extra_len != 0 {
                "extra_fields_unsupported"
            } else {
                "special_entry_unsupported"
            }));
        }
        let dos_directory = external_attributes == 0x10;
        let name = validate_name(raw_name, dos_directory)?;
        if !exact_names.insert(name.clone()) || !folded_names.insert(name.to_ascii_lowercase()) {
            return Err(ArchiveError::new("duplicate_entry_name"));
        }
        entries.push(CentralEntry {
            name,
            flags,
            method,
            crc32,
            compressed_size,
            size,
            local_header_offset,
        });
        cursor += record_len;
    }
    if entries.len() != total_entries as usize {
        return Err(ArchiveError::new("invalid_central_directory"));
    }
    Ok(Preflight {
        entries,
        central_offset: central_offset as u64,
    })
}

fn validate_local_headers<R: Read + Seek>(
    reader: &mut R,
    entries: &[CentralEntry],
    central_offset: u64,
) -> Result<(), ArchiveError> {
    let mut ranges = Vec::with_capacity(entries.len());
    for entry in entries {
        reader
            .seek(SeekFrom::Start(entry.local_header_offset as u64))
            .map_err(|error| ArchiveError::io("archive_read_failed", error))?;
        let mut local = [0u8; 30];
        reader
            .read_exact(&mut local)
            .map_err(|error| ArchiveError::io("entry_open_failed", error))?;
        let name_len = u16_at(&local, 26) as usize;
        let extra_len = u16_at(&local, 28) as usize;
        let data_start = (entry.local_header_offset as u64)
            .checked_add(local.len() as u64)
            .and_then(|value| value.checked_add(name_len as u64))
            .and_then(|value| value.checked_add(extra_len as u64))
            .ok_or_else(|| ArchiveError::new("archive_view_mismatch"))?;
        let data_end = data_start
            .checked_add(entry.compressed_size as u64)
            .ok_or_else(|| ArchiveError::new("archive_view_mismatch"))?;
        if local[..4] != [0x50, 0x4b, 0x03, 0x04]
            || u16_at(&local, 6) != entry.flags
            || u16_at(&local, 8) != entry.method
            || u32_at(&local, 14) != entry.crc32
            || u32_at(&local, 18) != entry.compressed_size
            || u32_at(&local, 22) != entry.size
            || name_len != entry.name.len()
            || extra_len != 0
            || data_end > central_offset
        {
            return Err(ArchiveError::new("archive_view_mismatch"));
        }
        let mut local_name = vec![0; name_len];
        reader
            .read_exact(&mut local_name)
            .map_err(|error| ArchiveError::io("entry_open_failed", error))?;
        if local_name != entry.name.as_bytes() {
            return Err(ArchiveError::new("archive_view_mismatch"));
        }
        ranges.push((entry.local_header_offset as u64, data_end));
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(ArchiveError::new("overlapping_entries"));
    }
    Ok(())
}

fn validated_archive<R: Read + Seek>(
    mut reader: R,
    max_archive_bytes: u64,
) -> Result<ValidatedArchive<R>, ArchiveError> {
    let preflight = preflight(&mut reader, max_archive_bytes)?;
    validate_local_headers(&mut reader, &preflight.entries, preflight.central_offset)?;
    Ok(ValidatedArchive {
        reader,
        entries: preflight.entries,
    })
}

fn read_entry<R: Read + Seek, W: Write>(
    validated: &mut ValidatedArchive<R>,
    index: usize,
    max_bytes: u64,
    writer: &mut W,
) -> Result<ExtractedFile, ArchiveError> {
    let expected = &validated.entries[index];
    if expected.size as u64 > max_bytes {
        return Err(ArchiveError::new("entry_size_limit"));
    }
    validated
        .reader
        .seek(SeekFrom::Start(expected.local_header_offset as u64))
        .map_err(|error| ArchiveError::io("archive_read_failed", error))?;
    let mut local = [0u8; 30];
    validated
        .reader
        .read_exact(&mut local)
        .map_err(|error| ArchiveError::io("entry_open_failed", error))?;
    if local[..4] != [0x50, 0x4b, 0x03, 0x04]
        || u16_at(&local, 6) != expected.flags
        || u16_at(&local, 8) != expected.method
        || u32_at(&local, 14) != expected.crc32
        || u32_at(&local, 18) != expected.compressed_size
        || u32_at(&local, 22) != expected.size
    {
        return Err(ArchiveError::new("archive_view_mismatch"));
    }
    let name_len = u16_at(&local, 26) as usize;
    let extra_len = u16_at(&local, 28) as usize;
    if name_len != expected.name.len() {
        return Err(ArchiveError::new("archive_view_mismatch"));
    }
    let mut local_name = vec![0; name_len];
    validated
        .reader
        .read_exact(&mut local_name)
        .map_err(|error| ArchiveError::io("entry_open_failed", error))?;
    if local_name != expected.name.as_bytes() {
        return Err(ArchiveError::new("archive_view_mismatch"));
    }
    validated
        .reader
        .seek(SeekFrom::Current(extra_len as i64))
        .map_err(|error| ArchiveError::io("entry_open_failed", error))?;
    let mut sha = Sha256::new();
    let mut crc = Crc32::new();
    let mut total = 0u64;
    let mut chunk = [0u8; COPY_CHUNK_BYTES];
    loop {
        let remaining = (expected.size as u64 - total).min(COPY_CHUNK_BYTES as u64) as usize;
        if remaining == 0 {
            break;
        }
        let read = validated
            .reader
            .read(&mut chunk[..remaining])
            .map_err(|error| ArchiveError::io("entry_read_failed", error))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| ArchiveError::new("entry_size_limit"))?;
        if total > max_bytes || total > expected.size as u64 {
            return Err(ArchiveError::new("entry_size_limit"));
        }
        writer
            .write_all(&chunk[..read])
            .map_err(|error| ArchiveError::io("output_write_failed", error))?;
        sha.update(&chunk[..read]);
        crc.update(&chunk[..read]);
    }
    if total != expected.size as u64 || crc.finalize() != expected.crc32 {
        return Err(ArchiveError::new("entry_integrity_failed"));
    }
    Ok(ExtractedFile {
        byte_size: total,
        sha256: format!("{:x}", sha.finalize()),
    })
}

pub fn inspect_manifest(
    input: &Path,
    limits: ArchiveLimits,
) -> Result<ManifestInspection, ArchiveError> {
    let file = File::open(input).map_err(|error| ArchiveError::io("archive_open_failed", error))?;
    let mut validated = validated_archive(file, limits.max_archive_bytes)?;
    let index = validated
        .entries
        .iter()
        .position(|entry| entry.name == MANIFEST_PATH)
        .ok_or_else(|| ArchiveError::new("manifest_missing"))?;
    let mut bytes = Vec::with_capacity(
        (validated.entries[index].size as u64).min(limits.max_manifest_bytes) as usize,
    );
    let result = read_entry(&mut validated, index, limits.max_manifest_bytes, &mut bytes)?;
    Ok(ManifestInspection {
        manifest_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        byte_size: result.byte_size,
        sha256: result.sha256,
        entry_count: validated.entries.len(),
    })
}

pub fn extract_file(
    input: &Path,
    entry_name: &str,
    output: &Path,
    max_archive_bytes: u64,
    max_file_bytes: u64,
) -> Result<ExtractedFile, ArchiveError> {
    if !input.is_absolute()
        || !output.is_absolute()
        || output.parent().is_none_or(|parent| !parent.is_dir())
    {
        return Err(ArchiveError::new("absolute_existing_paths_required"));
    }
    let file = File::open(input).map_err(|error| ArchiveError::io("archive_open_failed", error))?;
    let mut validated = validated_archive(file, max_archive_bytes)?;
    let index = validated
        .entries
        .iter()
        .position(|entry| entry.name == entry_name)
        .ok_or_else(|| ArchiveError::new("entry_missing"))?;
    if entry_name.ends_with('/') {
        return Err(ArchiveError::new("target_not_file"));
    }
    let mut output_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|error| {
            ArchiveError::io(
                if error.kind() == io::ErrorKind::AlreadyExists {
                    "output_exists"
                } else {
                    "output_create_failed"
                },
                error,
            )
        })?;
    let result =
        read_entry(&mut validated, index, max_file_bytes, &mut output_file).and_then(|result| {
            output_file
                .flush()
                .map_err(|error| ArchiveError::io("output_flush_failed", error))?;
            output_file
                .sync_all()
                .map_err(|error| ArchiveError::io("output_flush_failed", error))?;
            Ok(result)
        });
    drop(output_file);
    if result.is_err() && std::fs::remove_file(output).is_err() {
        return Err(ArchiveError::new("partial_output_cleanup_failed"));
    }
    result
}

#[derive(Debug)]
struct PreparedEntry {
    archive_path: String,
    source_file: Option<File>,
    source_path: Option<std::path::PathBuf>,
    size: u32,
    crc32: u32,
    sha256: String,
    directory: bool,
    local_offset: u32,
}

fn read_bounded_file(
    path: &Path,
    max_bytes: u64,
    code: &'static str,
) -> Result<Vec<u8>, ArchiveError> {
    if !path.is_absolute() {
        return Err(ArchiveError::new("absolute_existing_paths_required"));
    }
    let file = File::open(path).map_err(|error| ArchiveError::io(code, error))?;
    let size = file
        .metadata()
        .map_err(|error| ArchiveError::io(code, error))?
        .len();
    if size > max_bytes {
        return Err(ArchiveError::new("create_plan_size_limit"));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ArchiveError::io(code, error))?;
    if bytes.len() as u64 > max_bytes {
        return Err(ArchiveError::new("create_plan_size_limit"));
    }
    Ok(bytes)
}

fn open_and_hash_source(
    path: &Path,
    max_file_bytes: u64,
) -> Result<(File, u32, u32, String), ArchiveError> {
    if !path.is_absolute() {
        return Err(ArchiveError::new("absolute_existing_paths_required"));
    }
    let path_metadata = fs::symlink_metadata(path)
        .map_err(|error| ArchiveError::io("source_open_failed", error))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(ArchiveError::new("source_not_regular_file"));
    }
    let mut file =
        File::open(path).map_err(|error| ArchiveError::io("source_open_failed", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| ArchiveError::io("source_open_failed", error))?;
    if !metadata.is_file() {
        return Err(ArchiveError::new("source_not_regular_file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != metadata.dev() || path_metadata.ino() != metadata.ino() {
            return Err(ArchiveError::new("source_changed"));
        }
    }
    if metadata.len() > max_file_bytes || metadata.len() > u32::MAX as u64 {
        return Err(ArchiveError::new("source_size_limit"));
    }
    let mut crc = Crc32::new();
    let mut sha = Sha256::new();
    let mut total = 0u64;
    let mut chunk = [0u8; COPY_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|error| ArchiveError::io("source_read_failed", error))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_file_bytes || total > u32::MAX as u64 {
            return Err(ArchiveError::new("source_size_limit"));
        }
        crc.update(&chunk[..read]);
        sha.update(&chunk[..read]);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| ArchiveError::io("source_read_failed", error))?;
    Ok((
        file,
        total as u32,
        crc.finalize(),
        format!("{:x}", sha.finalize()),
    ))
}

fn validate_bound_source(path: &Path, file: &File) -> Result<(), ArchiveError> {
    let path_metadata =
        fs::symlink_metadata(path).map_err(|_| ArchiveError::new("source_changed"))?;
    let file_metadata = file
        .metadata()
        .map_err(|_| ArchiveError::new("source_changed"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(ArchiveError::new("source_changed"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != file_metadata.dev() || path_metadata.ino() != file_metadata.ino()
        {
            return Err(ArchiveError::new("source_changed"));
        }
    }
    Ok(())
}

fn write_u16<W: Write>(writer: &mut W, value: u16) -> Result<(), ArchiveError> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|error| ArchiveError::io("archive_write_failed", error))
}

fn write_u32<W: Write>(writer: &mut W, value: u32) -> Result<(), ArchiveError> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|error| ArchiveError::io("archive_write_failed", error))
}

fn write_local_header<W: Write>(writer: &mut W, entry: &PreparedEntry) -> Result<(), ArchiveError> {
    write_u32(writer, 0x0403_4b50)?;
    write_u16(writer, 20)?;
    write_u16(writer, 0x0800)?;
    write_u16(writer, 0)?;
    write_u16(writer, 0)?;
    write_u16(writer, 0x0021)?;
    write_u32(writer, entry.crc32)?;
    write_u32(writer, entry.size)?;
    write_u32(writer, entry.size)?;
    write_u16(writer, entry.archive_path.len() as u16)?;
    write_u16(writer, 0)?;
    writer
        .write_all(entry.archive_path.as_bytes())
        .map_err(|error| ArchiveError::io("archive_write_failed", error))
}

fn write_central_header<W: Write>(
    writer: &mut W,
    entry: &PreparedEntry,
) -> Result<(), ArchiveError> {
    write_u32(writer, 0x0201_4b50)?;
    write_u16(writer, 20)?;
    write_u16(writer, 20)?;
    write_u16(writer, 0x0800)?;
    write_u16(writer, 0)?;
    write_u16(writer, 0)?;
    write_u16(writer, 0x0021)?;
    write_u32(writer, entry.crc32)?;
    write_u32(writer, entry.size)?;
    write_u32(writer, entry.size)?;
    write_u16(writer, entry.archive_path.len() as u16)?;
    write_u16(writer, 0)?;
    write_u16(writer, 0)?;
    write_u16(writer, 0)?;
    write_u16(writer, 0)?;
    write_u32(writer, if entry.directory { 0x10 } else { 0 })?;
    write_u32(writer, entry.local_offset)?;
    writer
        .write_all(entry.archive_path.as_bytes())
        .map_err(|error| ArchiveError::io("archive_write_failed", error))
}

struct HashingWriter<W> {
    inner: W,
    sha: Sha256,
    bytes: u64,
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, value: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(value)?;
        self.sha.update(&value[..written]);
        self.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn unique_temp_path(output: &Path) -> Result<(std::path::PathBuf, File), ArchiveError> {
    let parent = output
        .parent()
        .filter(|value| value.is_dir())
        .ok_or_else(|| ArchiveError::new("absolute_existing_paths_required"))?;
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ArchiveError::new("invalid_output_path"))?;
    for attempt in 0..100u32 {
        let candidate = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), attempt));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(ArchiveError::io("output_create_failed", error)),
        }
    }
    Err(ArchiveError::new("output_create_failed"))
}

trait PublicationFs {
    fn link(&self, source: &Path, output: &Path) -> io::Result<()>;
    fn remove(&self, path: &Path) -> io::Result<()>;
    fn sync_parent(&self, output: &Path) -> io::Result<()>;
}

struct RealPublicationFs;

fn sync_file(file: &File) -> io::Result<()> {
    let attempts = if cfg!(windows) { 8 } else { 1 };
    let mut last_error = None;
    for attempt in 0..attempts {
        match file.sync_all() {
            Ok(()) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && error.kind() == io::ErrorKind::PermissionDenied
                    && attempt + 1 < attempts =>
            {
                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.expect("sync retry must retain its last error"))
}

impl PublicationFs for RealPublicationFs {
    fn link(&self, source: &Path, output: &Path) -> io::Result<()> {
        fs::hard_link(source, output)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn sync_parent(&self, output: &Path) -> io::Result<()> {
        let directory = match File::open(output.parent().unwrap()) {
            Ok(directory) => directory,
            // Windows does not expose a directory handle with the access mode
            // used by std::fs::File::open on hosted runners. The file itself
            // is already flushed and synced; keep publication atomic while
            // treating this metadata-only durability step as best effort.
            Err(error) if cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied => {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        match sync_file(&directory) {
            Err(error) if cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied => {
                Ok(())
            }
            result => result,
        }
    }
}

fn publish_archive(
    filesystem: &impl PublicationFs,
    temp_path: &Path,
    output: &Path,
) -> Result<(), ArchiveError> {
    filesystem
        .sync_parent(output)
        .map_err(|error| ArchiveError::io("output_flush_failed", error))?;
    filesystem.link(temp_path, output).map_err(|error| {
        ArchiveError::io(
            if error.kind() == io::ErrorKind::AlreadyExists {
                "output_exists"
            } else {
                "output_publish_failed"
            },
            error,
        )
    })?;
    if filesystem.sync_parent(output).is_err() {
        if filesystem.remove(output).is_err() || filesystem.sync_parent(output).is_err() {
            return Err(ArchiveError::new("publication_recovery_required"));
        }
        return Err(ArchiveError::new("output_publish_failed"));
    }
    if filesystem.remove(temp_path).is_err() || filesystem.sync_parent(output).is_err() {
        return Err(ArchiveError::new("published_output_cleanup_failed"));
    }
    Ok(())
}

pub fn create_archive(
    plan_path: &Path,
    output: &Path,
    max_archive_bytes: u64,
    max_file_bytes: u64,
    max_total_file_bytes: u64,
) -> Result<CreatedArchive, ArchiveError> {
    if !output.is_absolute() {
        return Err(ArchiveError::new("absolute_existing_paths_required"));
    }
    if output.exists() {
        return Err(ArchiveError::new("output_exists"));
    }
    let plan_bytes =
        read_bounded_file(plan_path, MAX_CREATE_PLAN_BYTES, "create_plan_read_failed")?;
    let plan: CreatePlan = serde_json::from_slice(&plan_bytes)
        .map_err(|_| ArchiveError::new("invalid_create_plan"))?;
    if plan.protocol_version != CREATE_PROTOCOL_VERSION
        || plan.entries.len() + 1 > MAX_ENTRIES
        || plan.tree_sha256.len() != 64
        || !plan
            .tree_sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    {
        return Err(ArchiveError::new("invalid_create_plan"));
    }

    let (manifest_file, manifest_size, manifest_crc, manifest_sha256) =
        open_and_hash_source(&plan.manifest_source, max_file_bytes)?;
    let mut prepared = vec![PreparedEntry {
        archive_path: MANIFEST_PATH.to_owned(),
        source_file: Some(manifest_file),
        source_path: Some(plan.manifest_source),
        size: manifest_size,
        crc32: manifest_crc,
        sha256: manifest_sha256.clone(),
        directory: false,
        local_offset: 0,
    }];
    let mut names = HashSet::from([MANIFEST_PATH.to_owned()]);
    let mut folded = HashSet::from([MANIFEST_PATH.to_ascii_lowercase()]);
    // The public total-file budget applies to workspace content only. The
    // generated manifest is bounded by max_file_bytes above, while directory
    // entries have no content bytes and therefore do not consume this budget.
    let mut total_file_bytes = 0u64;
    let mut total_name_bytes = MANIFEST_PATH.len();
    for item in plan.entries {
        let (archive_path, source_path, directory) = match item {
            CreateEntry::File {
                archive_path,
                source_path,
            } => (archive_path, Some(source_path), false),
            CreateEntry::Directory { archive_path } => (archive_path, None, true),
        };
        let archive_path = validate_name(archive_path.as_bytes(), directory)?;
        total_name_bytes += archive_path.len();
        if total_name_bytes > MAX_AGGREGATE_NAME_BYTES
            || !names.insert(archive_path.clone())
            || !folded.insert(archive_path.to_ascii_lowercase())
        {
            return Err(ArchiveError::new("duplicate_entry_name"));
        }
        let (source_file, size, crc32, sha256) = if let Some(source) = source_path.as_deref() {
            let (file, size, crc32, sha256) = open_and_hash_source(source, max_file_bytes)?;
            (Some(file), size, crc32, sha256)
        } else {
            (None, 0, 0, format!("{:x}", Sha256::digest([])))
        };
        total_file_bytes = total_file_bytes
            .checked_add(size as u64)
            .ok_or_else(|| ArchiveError::new("total_file_size_limit"))?;
        if total_file_bytes > max_total_file_bytes {
            return Err(ArchiveError::new("total_file_size_limit"));
        }
        prepared.push(PreparedEntry {
            archive_path,
            source_file,
            source_path,
            size,
            crc32,
            sha256,
            directory,
            local_offset: 0,
        });
    }

    let local_bytes = prepared.iter().try_fold(0u64, |total, entry| {
        total
            .checked_add(30 + entry.archive_path.len() as u64 + entry.size as u64)
            .ok_or_else(|| ArchiveError::new("archive_size_limit"))
    })?;
    let central_bytes = prepared.iter().try_fold(0u64, |total, entry| {
        total
            .checked_add(CENTRAL_FIXED_BYTES as u64 + entry.archive_path.len() as u64)
            .ok_or_else(|| ArchiveError::new("central_directory_limit"))
    })?;
    if central_bytes > MAX_CENTRAL_BYTES {
        return Err(ArchiveError::new("central_directory_limit"));
    }
    let predicted_archive_bytes = local_bytes
        .checked_add(central_bytes)
        .and_then(|value| value.checked_add(EOCD_FIXED_BYTES as u64))
        .ok_or_else(|| ArchiveError::new("archive_size_limit"))?;
    if predicted_archive_bytes > max_archive_bytes || predicted_archive_bytes > u32::MAX as u64 {
        return Err(ArchiveError::new("archive_size_limit"));
    }

    let (temp_path, temp_file) = unique_temp_path(output)?;
    let result = (|| {
        let mut writer = HashingWriter {
            inner: temp_file,
            sha: Sha256::new(),
            bytes: 0,
        };
        for entry in &mut prepared {
            entry.local_offset =
                u32::try_from(writer.bytes).map_err(|_| ArchiveError::new("archive_size_limit"))?;
            write_local_header(&mut writer, entry)?;
            if let (Some(source), Some(source_path)) = (&mut entry.source_file, &entry.source_path)
            {
                validate_bound_source(source_path, source)?;
                source
                    .seek(SeekFrom::Start(0))
                    .map_err(|error| ArchiveError::io("source_read_failed", error))?;
                let mut crc = Crc32::new();
                let mut sha = Sha256::new();
                let mut observed = 0u64;
                let mut chunk = [0u8; COPY_CHUNK_BYTES];
                loop {
                    let read = source
                        .read(&mut chunk)
                        .map_err(|error| ArchiveError::io("source_read_failed", error))?;
                    if read == 0 {
                        break;
                    }
                    observed += read as u64;
                    if observed > entry.size as u64 {
                        return Err(ArchiveError::new("source_changed"));
                    }
                    writer
                        .write_all(&chunk[..read])
                        .map_err(|error| ArchiveError::io("archive_write_failed", error))?;
                    crc.update(&chunk[..read]);
                    sha.update(&chunk[..read]);
                }
                if observed != entry.size as u64
                    || crc.finalize() != entry.crc32
                    || format!("{:x}", sha.finalize()) != entry.sha256
                {
                    return Err(ArchiveError::new("source_changed"));
                }
            }
            if writer.bytes > max_archive_bytes {
                return Err(ArchiveError::new("archive_size_limit"));
            }
        }
        let central_offset =
            u32::try_from(writer.bytes).map_err(|_| ArchiveError::new("archive_size_limit"))?;
        for entry in &prepared {
            write_central_header(&mut writer, entry)?;
        }
        let central_size = u32::try_from(writer.bytes - central_offset as u64)
            .map_err(|_| ArchiveError::new("central_directory_limit"))?;
        write_u32(&mut writer, 0x0605_4b50)?;
        write_u16(&mut writer, 0)?;
        write_u16(&mut writer, 0)?;
        write_u16(&mut writer, prepared.len() as u16)?;
        write_u16(&mut writer, prepared.len() as u16)?;
        write_u32(&mut writer, central_size)?;
        write_u32(&mut writer, central_offset)?;
        write_u16(&mut writer, 0)?;
        if writer.bytes > max_archive_bytes {
            return Err(ArchiveError::new("archive_size_limit"));
        }
        writer
            .flush()
            .map_err(|error| ArchiveError::io("output_flush_failed", error))?;
        sync_file(&writer.inner).map_err(|error| ArchiveError::io("output_flush_failed", error))?;
        let byte_size = writer.bytes;
        let archive_sha256 = format!("{:x}", writer.sha.finalize());
        drop(writer.inner);
        publish_archive(&RealPublicationFs, &temp_path, output)?;
        Ok(CreatedArchive {
            byte_size,
            sha256: archive_sha256,
            manifest_sha256,
            tree_sha256: plan.tree_sha256,
            entry_count: prepared.len(),
        })
    })();
    if result.is_err()
        && result.as_ref().err().is_none_or(|error| {
            !matches!(
                error.code(),
                "published_output_cleanup_failed" | "publication_recovery_required"
            )
        })
        && temp_path.exists()
        && fs::remove_file(&temp_path).is_err()
    {
        return Err(ArchiveError::new("temp_output_cleanup_failed"));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::Cursor;
    use std::rc::Rc;

    #[derive(Default)]
    struct FaultPublicationFs {
        calls: RefCell<Vec<&'static str>>,
        fail_calls: RefCell<Vec<usize>>,
    }

    impl FaultPublicationFs {
        fn failing(calls: &[usize]) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                fail_calls: RefCell::new(calls.to_vec()),
            }
        }

        fn operation(&self, name: &'static str) -> io::Result<()> {
            let number = self.calls.borrow().len() + 1;
            self.calls.borrow_mut().push(name);
            if self.fail_calls.borrow().contains(&number) {
                Err(io::Error::other("injected publication failure"))
            } else {
                Ok(())
            }
        }
    }

    impl PublicationFs for FaultPublicationFs {
        fn link(&self, _source: &Path, _output: &Path) -> io::Result<()> {
            self.operation("link")
        }
        fn remove(&self, path: &Path) -> io::Result<()> {
            self.operation(if path == Path::new("output") {
                "remove_output"
            } else {
                "remove_temp"
            })
        }
        fn sync_parent(&self, _output: &Path) -> io::Result<()> {
            self.operation("sync_parent")
        }
    }

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

    struct TrackingReader {
        inner: Cursor<Vec<u8>>,
        reads: Rc<RefCell<Vec<(u64, u64)>>>,
    }

    impl Read for TrackingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let start = self.inner.position();
            let read = self.inner.read(buffer)?;
            self.reads.borrow_mut().push((start, start + read as u64));
            Ok(read)
        }
    }

    impl Seek for TrackingReader {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.inner.seek(position)
        }
    }

    fn validation_error(bytes: Vec<u8>) -> &'static str {
        match validated_archive(Cursor::new(bytes), 1_000_000) {
            Ok(_) => panic!("archive validation unexpectedly succeeded"),
            Err(error) => error.code(),
        }
    }

    #[test]
    fn publication_failures_have_unambiguous_terminal_codes() {
        let cases: &[(&[usize], &str, &[&str])] = &[
            (&[1], "output_flush_failed", &["sync_parent"]),
            (&[2], "output_publish_failed", &["sync_parent", "link"]),
            (
                &[3],
                "output_publish_failed",
                &[
                    "sync_parent",
                    "link",
                    "sync_parent",
                    "remove_output",
                    "sync_parent",
                ],
            ),
            (
                &[3, 4],
                "publication_recovery_required",
                &["sync_parent", "link", "sync_parent", "remove_output"],
            ),
            (
                &[3, 5],
                "publication_recovery_required",
                &[
                    "sync_parent",
                    "link",
                    "sync_parent",
                    "remove_output",
                    "sync_parent",
                ],
            ),
            (
                &[4],
                "published_output_cleanup_failed",
                &["sync_parent", "link", "sync_parent", "remove_temp"],
            ),
            (
                &[5],
                "published_output_cleanup_failed",
                &[
                    "sync_parent",
                    "link",
                    "sync_parent",
                    "remove_temp",
                    "sync_parent",
                ],
            ),
        ];
        for (failures, code, expected_calls) in cases {
            let filesystem = FaultPublicationFs::failing(failures);
            let error =
                publish_archive(&filesystem, Path::new("temp"), Path::new("output")).unwrap_err();
            assert_eq!(error.code(), *code);
            assert_eq!(filesystem.calls.borrow().as_slice(), *expected_calls);
        }
    }

    #[cfg(unix)]
    #[test]
    fn bound_source_detects_inter_pass_symlink_replacement() {
        use std::os::unix::fs::symlink;
        use tempfile::tempdir;

        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let replacement = root.path().join("replacement");
        fs::write(&source, b"same").unwrap();
        fs::write(&replacement, b"same").unwrap();
        let (file, _, _, _) = open_and_hash_source(&source, 100).unwrap();
        fs::remove_file(&source).unwrap();
        symlink(&replacement, &source).unwrap();
        assert_eq!(
            validate_bound_source(&source, &file).unwrap_err().code(),
            "source_changed"
        );
    }

    fn first_central(bytes: &[u8]) -> usize {
        bytes
            .windows(4)
            .position(|value| value == 0x02014b50u32.to_le_bytes())
            .unwrap()
    }

    #[test]
    fn inspects_only_the_bounded_manifest_result() {
        let unrelated = vec![7; 200_000];
        let bytes = fixture(&[
            (MANIFEST_PATH, br#"{"version":2}"#),
            ("workspace/large.bin", &unrelated),
        ]);
        let unrelated_start = bytes
            .windows(unrelated.len())
            .position(|window| window == unrelated)
            .unwrap() as u64;
        let unrelated_end = unrelated_start + unrelated.len() as u64;
        let reads = Rc::new(RefCell::new(Vec::new()));
        let reader = TrackingReader {
            inner: Cursor::new(bytes),
            reads: Rc::clone(&reads),
        };
        let mut validated = validated_archive(reader, 1_000_000).unwrap();
        let index = validated
            .entries
            .iter()
            .position(|entry| entry.name == MANIFEST_PATH)
            .unwrap();
        let mut manifest = Vec::new();
        let result = read_entry(&mut validated, index, 1024, &mut manifest).unwrap();
        assert_eq!(manifest, br#"{"version":2}"#);
        assert_eq!(result.byte_size, 13);
        assert!(
            reads
                .borrow()
                .iter()
                .all(|(start, end)| *end <= unrelated_start || *start >= unrelated_end),
            "manifest inspection read unrelated file body at {unrelated_start}..{unrelated_end}; reads={:?}",
            reads.borrow()
        );
    }

    #[test]
    fn rejects_case_collisions_archive_wide() {
        let bytes = fixture(&[
            (MANIFEST_PATH, b"{}"),
            ("workspace/A.txt", b"a"),
            ("workspace/a.txt", b"b"),
        ]);
        assert_eq!(validation_error(bytes), "duplicate_entry_name");
    }

    #[test]
    fn rejects_unsafe_names_and_zip64_before_library_parsing() {
        let unsafe_archive = fixture(&[(MANIFEST_PATH, b"{}"), ("workspace/../secret", b"x")]);
        assert_eq!(validation_error(unsafe_archive), "unsafe_entry_name");

        let mut zip64 = fixture(&[(MANIFEST_PATH, b"{}")]);
        let eocd = zip64.len() - EOCD_FIXED_BYTES;
        zip64[eocd + 10..eocd + 12].copy_from_slice(&u16::MAX.to_le_bytes());
        assert_eq!(validation_error(zip64), "zip64_unsupported");
    }

    #[test]
    fn rejects_encryption_and_compression_archive_wide() {
        let mut encrypted = fixture(&[(MANIFEST_PATH, b"{}")]);
        let central = first_central(&encrypted);
        encrypted[central + 8..central + 10].copy_from_slice(&0x0801u16.to_le_bytes());
        assert_eq!(validation_error(encrypted), "encrypted_entry_unsupported");

        let mut compressed = fixture(&[(MANIFEST_PATH, b"{}")]);
        let central = first_central(&compressed);
        compressed[central + 10..central + 12].copy_from_slice(&8u16.to_le_bytes());
        assert_eq!(validation_error(compressed), "unsupported_entry_encoding");
    }

    #[test]
    fn create_entry_limit_counts_generated_manifest_entry() {
        use tempfile::tempdir;

        let root = tempdir().unwrap();
        let manifest = root.path().join("manifest.json");
        let plan = root.path().join("plan.json");
        let archive = root.path().join("archive.zip");
        let too_many_plan = root.path().join("too-many-plan.json");
        let too_many_archive = root.path().join("too-many.zip");
        fs::write(&manifest, b"{}").unwrap();

        let write_plan = |path: &Path, entry_count: usize| {
            let entries: Vec<_> = (0..entry_count)
                .map(|index| {
                    serde_json::json!({
                        "kind": "directory",
                        "archivePath": format!("workspace/directory-{index}/")
                    })
                })
                .collect();
            fs::write(
                path,
                serde_json::to_vec(&serde_json::json!({
                    "protocolVersion": CREATE_PROTOCOL_VERSION,
                    "manifestSource": manifest,
                    "treeSha256": "a".repeat(64),
                    "entries": entries
                }))
                .unwrap(),
            )
            .unwrap();
        };

        write_plan(&plan, MAX_ENTRIES - 1);
        let created = create_archive(&plan, &archive, 8 * 1024 * 1024, 1024, 1024).unwrap();
        assert_eq!(created.entry_count, MAX_ENTRIES);
        assert!(archive.is_file());

        write_plan(&too_many_plan, MAX_ENTRIES);
        let error = create_archive(
            &too_many_plan,
            &too_many_archive,
            8 * 1024 * 1024,
            1024,
            1024,
        )
        .unwrap_err();
        assert_eq!(error.code(), "invalid_create_plan");
        assert!(!too_many_archive.exists());
    }

    #[test]
    fn total_content_limit_excludes_manifest_and_rejects_one_byte_overflow() {
        use tempfile::tempdir;

        let root = tempdir().unwrap();
        let manifest = root.path().join("manifest.json");
        let plan = root.path().join("plan.json");
        let archive = root.path().join("archive.zip");
        let overflow_plan = root.path().join("overflow-plan.json");
        let overflow_archive = root.path().join("overflow.zip");
        fs::write(&manifest, b"{}").unwrap();

        const TOTAL_CONTENT_BYTES: usize = 100 * 1024 * 1024;
        const FILE_BYTES: usize = 5 * 1024 * 1024;
        const FILE_COUNT: usize = TOTAL_CONTENT_BYTES / FILE_BYTES;
        let payload = vec![0x61; FILE_BYTES];
        for index in 0..FILE_COUNT {
            fs::write(
                root.path().join(format!("payload-{index:02}.bin")),
                &payload,
            )
            .unwrap();
        }

        let write_plan = |path: &Path, first_file_size: usize| {
            let entries: Vec<_> = (0..FILE_COUNT)
                .map(|index| {
                    serde_json::json!({
                        "kind": "file",
                        "archivePath": format!("workspace/payload-{index:02}.bin"),
                        "sourcePath": root.path().join(format!("payload-{index:02}.bin")),
                    })
                })
                .collect();
            if first_file_size != FILE_BYTES {
                fs::write(
                    root.path().join("payload-00.bin"),
                    vec![0x61; first_file_size],
                )
                .unwrap();
            }
            fs::write(
                path,
                serde_json::to_vec(&serde_json::json!({
                    "protocolVersion": CREATE_PROTOCOL_VERSION,
                    "manifestSource": manifest,
                    "treeSha256": "a".repeat(64),
                    "entries": entries,
                }))
                .unwrap(),
            )
            .unwrap();
        };

        write_plan(&plan, FILE_BYTES);
        let created = create_archive(
            &plan,
            &archive,
            110 * 1024 * 1024,
            6 * 1024 * 1024,
            TOTAL_CONTENT_BYTES as u64,
        )
        .unwrap();
        assert_eq!(created.entry_count, FILE_COUNT + 1);
        assert!(archive.is_file());

        write_plan(&overflow_plan, FILE_BYTES + 1);
        let error = create_archive(
            &overflow_plan,
            &overflow_archive,
            110 * 1024 * 1024,
            6 * 1024 * 1024,
            TOTAL_CONTENT_BYTES as u64,
        )
        .unwrap_err();
        assert_eq!(error.code(), "total_file_size_limit");
        assert!(!overflow_archive.exists());
    }

    #[test]
    fn rejects_extra_fields_in_central_and_local_headers() {
        let mut central_extra = fixture(&[(MANIFEST_PATH, b"{}")]);
        let central = first_central(&central_extra);
        let name_len = u16_at(&central_extra, central + 28) as usize;
        central_extra[central + 30..central + 32].copy_from_slice(&1u16.to_le_bytes());
        central_extra.insert(central + CENTRAL_FIXED_BYTES + name_len, 0);
        let eocd = central_extra.len() - EOCD_FIXED_BYTES;
        let central_size = u32_at(&central_extra, eocd + 12) + 1;
        central_extra[eocd + 12..eocd + 16].copy_from_slice(&central_size.to_le_bytes());
        assert_eq!(validation_error(central_extra), "extra_fields_unsupported");

        let mut local_extra = fixture(&[(MANIFEST_PATH, b"{}")]);
        let name_len = u16_at(&local_extra, 26) as usize;
        local_extra[28..30].copy_from_slice(&1u16.to_le_bytes());
        local_extra.insert(30 + name_len, 0);
        let eocd = local_extra.len() - EOCD_FIXED_BYTES;
        let central_offset = u32_at(&local_extra, eocd + 16) + 1;
        local_extra[eocd + 16..eocd + 20].copy_from_slice(&central_offset.to_le_bytes());
        assert_eq!(validation_error(local_extra), "archive_view_mismatch");
    }

    #[test]
    fn rejects_unsupported_creator_and_dos_attributes() {
        let mut creator = fixture(&[(MANIFEST_PATH, b"{}")]);
        let central = first_central(&creator);
        creator[central + 5] = 3;
        assert_eq!(validation_error(creator), "special_entry_unsupported");

        let mut special = fixture(&[(MANIFEST_PATH, b"{}")]);
        let central = first_central(&special);
        special[central + 38..central + 42].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(validation_error(special), "special_entry_unsupported");

        let mut directory_mismatch = fixture(&[(MANIFEST_PATH, b"{}")]);
        let central = first_central(&directory_mismatch);
        directory_mismatch[central + 38..central + 42].copy_from_slice(&0x10u32.to_le_bytes());
        assert_eq!(validation_error(directory_mismatch), "unsafe_entry_name");
    }

    #[test]
    fn reports_writer_failure_after_partial_output() {
        struct FailingWriter {
            bytes: usize,
        }
        impl Write for FailingWriter {
            fn write(&mut self, value: &[u8]) -> io::Result<usize> {
                if self.bytes > 0 {
                    return Err(io::Error::other("injected writer failure"));
                }
                let accepted = value.len().min(127);
                self.bytes += accepted;
                Ok(accepted)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let body = vec![4; 4096];
        let bytes = fixture(&[(MANIFEST_PATH, b"{}"), ("workspace/file.bin", &body)]);
        let mut validated = validated_archive(Cursor::new(bytes), 1_000_000).unwrap();
        let index = validated
            .entries
            .iter()
            .position(|entry| entry.name == "workspace/file.bin")
            .unwrap();
        let mut writer = FailingWriter { bytes: 0 };
        let error = read_entry(&mut validated, index, body.len() as u64, &mut writer).unwrap_err();
        assert_eq!(error.code(), "output_write_failed");
        assert_eq!(writer.bytes, 127);
    }

    #[test]
    fn streams_targets_in_bounded_chunks() {
        struct BoundedWriter {
            bytes: usize,
        }
        impl Write for BoundedWriter {
            fn write(&mut self, value: &[u8]) -> io::Result<usize> {
                assert!(value.len() <= COPY_CHUNK_BYTES);
                self.bytes += value.len();
                Ok(value.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let body = vec![9; COPY_CHUNK_BYTES * 3 + 17];
        let bytes = fixture(&[(MANIFEST_PATH, b"{}"), ("workspace/file.bin", &body)]);
        let mut validated = validated_archive(Cursor::new(bytes), 1_000_000).unwrap();
        let index = validated
            .entries
            .iter()
            .position(|entry| entry.name == "workspace/file.bin")
            .unwrap();
        let mut writer = BoundedWriter { bytes: 0 };
        let result = read_entry(&mut validated, index, body.len() as u64, &mut writer).unwrap();
        assert_eq!(writer.bytes, body.len());
        assert_eq!(result.byte_size, body.len() as u64);
    }
}
