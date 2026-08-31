use base64::Engine;
use rudder_archive_core::{ArchiveEntryInspection, ArchiveLimits, MANIFEST_PATH, inspect_manifest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::Read,
    path::Path,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_ARCHIVE_BYTES: u64 = 116 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES: u64 = 100 * 1024 * 1024;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V1Artifact {
    version: u32,
    org_id: String,
    entries: Vec<ArtifactEntry>,
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

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ArtifactError {
    NotFound,
    Invalid,
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
    let file = File::open(path).map_err(|_| ArtifactError::Invalid)?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ArtifactError::Invalid)?;
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
    root_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(root_path)
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
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
        let artifact: V1Artifact =
            serde_json::from_slice(&bytes).map_err(|_| ArtifactError::Invalid)?;
        if artifact.version != 1 || artifact.org_id != org_id {
            return Err(ArtifactError::Invalid);
        }
        artifact.entries
    };

    for entry in &entries {
        validate_entry_path(&entry.path)?;
        if entry.kind != "directory" && entry.kind != "file" {
            return Err(ArtifactError::Invalid);
        }
    }
    Ok(entries)
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let entries = [
            "A", "a", "B", "b", "á", "â", "å", "ä", "ã", "é", "z", "file2", "file10", "Å",
            "a\u{301}", "\u{e000}", "😀",
        ]
        .into_iter()
        .map(|path| ArtifactEntry {
            path: path.into(),
            kind: "file".into(),
        })
        .collect::<Vec<_>>();
        assert_eq!(
            direct_children(&entries, "")
                .into_iter()
                .map(|entry| entry.name)
                .collect::<Vec<_>>(),
            [
                "A", "B", "a", "a\u{301}", "b", "file10", "file2", "z", "Å", "á", "â", "ã", "ä",
                "å", "é", "\u{e000}", "😀"
            ]
        );
    }
}
