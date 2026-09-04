use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Serialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

pub const PLUGIN_ARCHIVE_PROTOCOL_VERSION: u32 = 1;
const MAX_PATH_CHARS: usize = 1_024;

#[derive(Clone, Copy)]
pub struct PluginArchiveLimits {
    pub max_archive_bytes: u64,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_files: usize,
    pub max_expansion_ratio: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArchiveFile {
    pub path: String,
    pub content: String,
    pub encoding: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArchiveInspection {
    pub files: Vec<PluginArchiveFile>,
    pub archive_bytes: u64,
    pub total_bytes: u64,
    pub stripped_root: Option<String>,
}

#[derive(Debug)]
pub struct PluginArchiveError(&'static str);

impl PluginArchiveError {
    pub fn code(&self) -> &'static str {
        self.0
    }
}

fn error(code: &'static str) -> PluginArchiveError {
    PluginArchiveError(code)
}

fn normalized_path(raw: &[u8]) -> Result<String, PluginArchiveError> {
    let value = std::str::from_utf8(raw).map_err(|_| error("plugin_archive_path_invalid"))?;
    if value.chars().count() > MAX_PATH_CHARS || value.chars().any(char::is_control) {
        return Err(error("plugin_archive_path_invalid"));
    }
    let value = value.replace('\\', "/");
    let bytes = value.as_bytes();
    let windows_absolute =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    let raw_segments = value.split('/').collect::<Vec<_>>();
    if value.starts_with('/')
        || windows_absolute
        || raw_segments
            .iter()
            .any(|segment| *segment == "." || *segment == "..")
    {
        return Err(error("plugin_archive_path_unsafe"));
    }
    let normalized = raw_segments
        .into_iter()
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err(error("plugin_archive_path_unsafe"));
    }
    Ok(normalized)
}

fn common_plugin_root(paths: &[String]) -> Option<String> {
    let manifests = paths
        .iter()
        .filter_map(|path| path.strip_suffix("/.codex-plugin/plugin.json"))
        .filter(|prefix| !prefix.is_empty())
        .collect::<Vec<_>>();
    if manifests.len() != 1 {
        return None;
    }
    let root = manifests[0];
    let prefix = format!("{root}/");
    paths
        .iter()
        .all(|path| path.starts_with(&prefix))
        .then(|| root.to_owned())
}

pub fn inspect_plugin_archive(
    input: &Path,
    limits: PluginArchiveLimits,
    strip_plugin_root: bool,
) -> Result<PluginArchiveInspection, PluginArchiveError> {
    let file = File::open(input).map_err(|_| error("plugin_archive_open_failed"))?;
    let archive_bytes = file
        .metadata()
        .map_err(|_| error("plugin_archive_metadata_failed"))?
        .len();
    if archive_bytes == 0 || archive_bytes > limits.max_archive_bytes {
        return Err(error("plugin_archive_size_limit"));
    }
    let mut archive = ZipArchive::new(file).map_err(|_| error("plugin_archive_invalid"))?;
    let mut decoded = Vec::new();
    let mut total_bytes = 0_u64;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| error("plugin_archive_invalid"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_path = std::str::from_utf8(entry.name_raw())
            .map_err(|_| error("plugin_archive_path_invalid"))?
            .to_owned();
        let path = normalized_path(entry.name_raw())?;
        if decoded.len() >= limits.max_files {
            return Err(error("plugin_archive_file_count_limit"));
        }
        let size = entry.size();
        let compressed_size = entry.compressed_size();
        if size > limits.max_file_bytes {
            return Err(error("plugin_archive_file_size_limit"));
        }
        if size > 0
            && (compressed_size == 0
                || size
                    > compressed_size
                        .checked_mul(limits.max_expansion_ratio)
                        .ok_or_else(|| error("plugin_archive_expansion_limit"))?)
        {
            return Err(error("plugin_archive_expansion_limit"));
        }
        total_bytes = total_bytes
            .checked_add(size)
            .ok_or_else(|| error("plugin_archive_total_size_limit"))?;
        if total_bytes > limits.max_total_bytes
            || total_bytes
                > archive_bytes
                    .checked_mul(limits.max_expansion_ratio)
                    .ok_or_else(|| error("plugin_archive_expansion_limit"))?
        {
            return Err(error("plugin_archive_total_size_limit"));
        }
        let expected =
            usize::try_from(size).map_err(|_| error("plugin_archive_file_size_limit"))?;
        let mut bytes = Vec::with_capacity(expected);
        entry
            .take(limits.max_file_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| error("plugin_archive_read_failed"))?;
        if bytes.len() != expected {
            return Err(error("plugin_archive_size_mismatch"));
        }
        decoded.push((raw_path, path, bytes));
    }
    if decoded.is_empty() {
        return Err(error("plugin_archive_empty"));
    }

    let raw_paths = decoded
        .iter()
        .map(|(raw_path, _, _)| raw_path.clone())
        .collect::<Vec<_>>();
    let stripped_root = strip_plugin_root
        .then(|| common_plugin_root(&raw_paths))
        .flatten();
    let mut folded = HashSet::new();
    let files = decoded
        .into_iter()
        .map(|(raw_path, normalized, bytes)| {
            let projected = stripped_root
                .as_ref()
                .and_then(|root| raw_path.strip_prefix(&format!("{root}/")))
                .map(|path| normalized_path(path.as_bytes()))
                .transpose()?
                .unwrap_or(normalized);
            if !folded.insert(projected.to_lowercase()) {
                return Err(error("plugin_archive_duplicate_path"));
            }
            Ok(PluginArchiveFile {
                path: projected,
                content: BASE64.encode(bytes),
                encoding: "base64",
            })
        })
        .collect::<Result<Vec<_>, PluginArchiveError>>()?;
    Ok(PluginArchiveInspection {
        files,
        archive_bytes,
        total_bytes,
        stripped_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn fixture(
        entries: &[(&str, &[u8])],
        compression: zip::CompressionMethod,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempdir().unwrap();
        let path = root.path().join("plugin.zip");
        let file = File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (name, body) in entries {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().compression_method(compression),
                )
                .unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
        (root, path)
    }

    fn limits() -> PluginArchiveLimits {
        PluginArchiveLimits {
            max_archive_bytes: 10 * 1024 * 1024,
            max_file_bytes: 2 * 1024 * 1024,
            max_total_bytes: 10 * 1024 * 1024,
            max_files: 500,
            max_expansion_ratio: 100,
        }
    }

    #[test]
    fn decodes_deflate_and_strips_one_common_plugin_root() {
        let fixture_data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/plugin-archive-read-parity.json"
        ))
        .unwrap();
        let root = fixture_data["outerRoot"].as_str().unwrap();
        let owned = fixture_data["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                (
                    format!("{root}/{}", file["path"].as_str().unwrap()),
                    file["contentUtf8"].as_str().unwrap().as_bytes().to_vec(),
                )
            })
            .collect::<Vec<_>>();
        let borrowed = owned
            .iter()
            .map(|(path, body)| (path.as_str(), body.as_slice()))
            .collect::<Vec<_>>();
        let (_root, path) = fixture(&borrowed, zip::CompressionMethod::Deflated);
        let result = inspect_plugin_archive(&path, limits(), true).unwrap();
        assert_eq!(result.stripped_root.as_deref(), Some(root));
        assert_eq!(
            result
                .files
                .iter()
                .map(|file| &file.path)
                .collect::<Vec<_>>(),
            fixture_data["expectedPaths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| path.as_str().unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            BASE64.decode(&result.files[1].content).unwrap(),
            b"---\nname: Research\n---\n"
        );
    }

    #[test]
    fn rejects_unsafe_and_case_colliding_paths() {
        let (_root, path) = fixture(&[("../outside", b"x")], zip::CompressionMethod::Stored);
        assert_eq!(
            inspect_plugin_archive(&path, limits(), true)
                .unwrap_err()
                .code(),
            "plugin_archive_path_unsafe"
        );
        let (_root, path) = fixture(&[("A", b"x"), ("a", b"y")], zip::CompressionMethod::Stored);
        assert_eq!(
            inspect_plugin_archive(&path, limits(), true)
                .unwrap_err()
                .code(),
            "plugin_archive_duplicate_path"
        );
    }

    #[test]
    fn rejects_unbounded_and_control_character_paths() {
        for name in [
            format!("{}.txt", "a".repeat(1_025)),
            "bad\npath.txt".to_owned(),
        ] {
            let (_root, path) = fixture(
                &[(name.as_str(), b"unsafe")],
                zip::CompressionMethod::Stored,
            );
            let error = inspect_plugin_archive(&path, limits(), true).unwrap_err();
            assert_eq!(error.code(), "plugin_archive_path_invalid");
        }
    }

    #[test]
    fn enforces_file_and_expansion_bounds() {
        let (_root, path) = fixture(&[("large", &[1; 32])], zip::CompressionMethod::Stored);
        let mut bounded = limits();
        bounded.max_file_bytes = 16;
        assert_eq!(
            inspect_plugin_archive(&path, bounded, false)
                .unwrap_err()
                .code(),
            "plugin_archive_file_size_limit"
        );
        let zeros = vec![0; 512 * 1024];
        let (_root, path) = fixture(&[("bomb", &zeros)], zip::CompressionMethod::Deflated);
        assert_eq!(
            inspect_plugin_archive(&path, limits(), false)
                .unwrap_err()
                .code(),
            "plugin_archive_expansion_limit"
        );
    }
}
