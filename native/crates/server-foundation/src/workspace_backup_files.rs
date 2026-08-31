use base64::Engine;
use rudder_archive_core::{ArchiveLimits, inspect_manifest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

const MAX_ARCHIVE_BYTES: u64 = 116 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct WorkspaceBackupFilesQuery {
    #[serde(default)]
    pub(crate) path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactIdentity {
    org_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactEntry {
    path: String,
    kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Manifest {
    version: u32,
    identity: ArtifactIdentity,
    entries: Vec<ArtifactEntry>,
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
        if manifest.version != 2 || manifest.identity.org_id != org_id {
            return Err(ArtifactError::Invalid);
        }
        manifest.entries
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
            .then_with(|| node_filename_key(&left.name).cmp(&node_filename_key(&right.name)))
    });
    children
}

// Node's localeCompare groups accents with their base letter and orders lowercase
// before uppercase. Keep those observable semantics deterministic across Rust hosts.
fn node_filename_key(value: &str) -> (String, String, String, String) {
    let decomposed: Vec<char> = value.nfd().collect();
    let primary = decomposed
        .iter()
        .filter(|value| !is_combining_mark(**value))
        .flat_map(|value| value.to_lowercase())
        .collect();
    let secondary = decomposed
        .iter()
        .filter(|value| is_combining_mark(**value))
        .collect();
    let case = value
        .chars()
        .map(|value| {
            if value.is_lowercase() {
                '0'
            } else if value.is_uppercase() {
                '1'
            } else {
                '2'
            }
        })
        .collect();
    (primary, secondary, case, value.to_owned())
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
    fn filename_order_matches_node_locale_compare_cases() {
        let entries = ["A", "a", "B", "b", "á", "ä", "é", "z", "file2", "file10"]
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
            ["a", "A", "á", "ä", "b", "B", "é", "file10", "file2", "z"]
        );
    }
}
