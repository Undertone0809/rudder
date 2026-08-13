//! Bounded indexing for the local newline-delimited run-log format.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const INDEX_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexLimits {
    pub max_record_bytes: u64,
    pub max_records: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunLogRecord {
    pub ts: String,
    pub stream: String,
    pub chunk: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceIndexEntry {
    pub sequence: u64,
    pub source_offset: u64,
    pub source_length: u64,
    pub stream: String,
    pub chunk_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub protocol_version: u32,
    pub source_bytes: u64,
    pub record_count: u64,
    pub source_sha256: String,
    pub index_path: PathBuf,
}

#[derive(Debug)]
pub enum IndexError {
    Invalid(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid evidence: {message}"),
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Json(error) => write!(f, "invalid evidence JSON: {error}"),
        }
    }
}

impl std::error::Error for IndexError {}

impl From<io::Error> for IndexError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for IndexError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// Build an index sidecar for a run log without loading the complete log.
pub fn index_run_log(
    input: &Path,
    output: &Path,
    limits: IndexLimits,
) -> Result<IndexSummary, IndexError> {
    validate_limits(limits)?;
    let input_meta = fs::symlink_metadata(input)?;
    if input_meta.file_type().is_symlink() || !input_meta.is_file() {
        return Err(IndexError::Invalid("input must be a regular file".into()));
    }
    if output == input {
        return Err(IndexError::Invalid(
            "index output must differ from input".into(),
        ));
    }
    let parent = output
        .parent()
        .ok_or_else(|| IndexError::Invalid("index output parent is missing".into()))?;
    if !parent.is_dir() {
        return Err(IndexError::Invalid(
            "index output parent is unavailable".into(),
        ));
    }
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| IndexError::Invalid("index output name is invalid".into()))?;
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{name}.{}-{sequence}.tmp", std::process::id()));
    let result = build_index(input, output, &temp, limits);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn validate_limits(limits: IndexLimits) -> Result<(), IndexError> {
    if limits.max_record_bytes == 0 || limits.max_records == 0 {
        return Err(IndexError::Invalid("index limits must be positive".into()));
    }
    if limits.max_record_bytes > 64 * 1024 * 1024 {
        return Err(IndexError::Invalid(
            "maxRecordBytes exceeds hard limit".into(),
        ));
    }
    Ok(())
}

fn build_index(
    input: &Path,
    output: &Path,
    temp: &Path,
    limits: IndexLimits,
) -> Result<IndexSummary, IndexError> {
    let source = File::open(input)?;
    let mut reader = BufReader::new(source);
    let temp_file = OpenOptions::new().create_new(true).write(true).open(temp)?;
    let mut sidecar = BufWriter::new(temp_file);
    let mut source_hash = Sha256::new();
    let mut source_offset = 0_u64;
    let mut record_count = 0_u64;
    let mut line = Vec::with_capacity(limits.max_record_bytes.min(16 * 1024) as usize);
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if read as u64 > limits.max_record_bytes {
            return Err(IndexError::Invalid(format!(
                "record exceeds maxRecordBytes at offset {source_offset}"
            )));
        }
        if record_count >= limits.max_records {
            return Err(IndexError::Invalid(
                "record count exceeds maxRecords".into(),
            ));
        }
        source_hash.update(&line);
        let body = if line.last() == Some(&b'\n') {
            &line[..line.len() - 1]
        } else {
            line.as_slice()
        };
        if body.last() == Some(&b'\r') {
            return Err(IndexError::Invalid(
                "carriage-return line endings are not supported".into(),
            ));
        }
        if body.is_empty() {
            return Err(IndexError::Invalid(format!(
                "empty record at offset {source_offset}"
            )));
        }
        let record: RunLogRecord = serde_json::from_slice(body)?;
        validate_record(&record)?;
        let entry = EvidenceIndexEntry {
            sequence: record_count,
            source_offset,
            source_length: read as u64,
            stream: record.stream,
            chunk_bytes: record.chunk.len() as u64,
            sha256: format!("{:x}", Sha256::digest(record.chunk.as_bytes())),
        };
        serde_json::to_writer(&mut sidecar, &entry)?;
        sidecar.write_all(b"\n")?;
        source_offset += read as u64;
        record_count += 1;
    }
    sidecar.flush()?;
    sidecar.get_ref().sync_all()?;
    fs::rename(temp, output)?;
    Ok(IndexSummary {
        protocol_version: INDEX_PROTOCOL_VERSION,
        source_bytes: source_offset,
        record_count,
        source_sha256: format!("{:x}", source_hash.finalize()),
        index_path: output.to_path_buf(),
    })
}

fn validate_record(record: &RunLogRecord) -> Result<(), IndexError> {
    if record.ts.trim().is_empty() || record.ts.len() > 256 {
        return Err(IndexError::Invalid("record timestamp is invalid".into()));
    }
    if !matches!(record.stream.as_str(), "stdout" | "stderr" | "system") {
        return Err(IndexError::Invalid("record stream is invalid".into()));
    }
    if record.chunk.contains('\0') {
        return Err(IndexError::Invalid("record chunk contains NUL".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn limits() -> IndexLimits {
        IndexLimits {
            max_record_bytes: 1024,
            max_records: 10,
        }
    }

    #[test]
    fn indexes_offsets_and_chunk_digests() {
        let root = tempdir().unwrap();
        let input = root.path().join("run.ndjson");
        let output = root.path().join("run.index.ndjson");
        let body = concat!(
            r#"{"ts":"2026-08-13T00:00:00Z","stream":"stdout","chunk":"hello"}"#,
            "\n",
            r#"{"ts":"2026-08-13T00:00:01Z","stream":"stderr","chunk":"world"}"#,
            "\n"
        );
        std::fs::write(&input, body).unwrap();
        let summary = index_run_log(&input, &output, limits()).unwrap();
        assert_eq!(summary.record_count, 2);
        assert_eq!(summary.source_bytes, body.len() as u64);
        let entries: Vec<EvidenceIndexEntry> = std::fs::read_to_string(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries[0].source_offset, 0);
        assert_eq!(entries[1].source_offset, entries[0].source_length);
        assert_eq!(entries[0].chunk_bytes, 5);
        assert_eq!(entries[1].sequence, 1);
        assert!(entries.iter().all(|entry| entry.sha256.len() == 64));
    }

    #[test]
    fn rejects_oversized_records_without_publishing() {
        let root = tempdir().unwrap();
        let input = root.path().join("run.ndjson");
        let output = root.path().join("run.index.ndjson");
        std::fs::write(
            &input,
            r#"{"ts":"2026-08-13","stream":"stdout","chunk":"0123456789"}
"#,
        )
        .unwrap();
        let error = index_run_log(
            &input,
            &output,
            IndexLimits {
                max_record_bytes: 10,
                max_records: 10,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("maxRecordBytes"));
        assert!(!output.exists());
    }

    #[test]
    fn rejects_invalid_stream_and_crlf() {
        let root = tempdir().unwrap();
        let input = root.path().join("run.ndjson");
        let output = root.path().join("run.index.ndjson");
        std::fs::write(
            &input,
            r#"{"ts":"2026-08-13","stream":"other","chunk":"x"}
"#,
        )
        .unwrap();
        assert!(
            index_run_log(&input, &output, limits())
                .unwrap_err()
                .to_string()
                .contains("stream")
        );
        std::fs::write(
            &input,
            [
                br#"{"ts":"2026-08-13","stream":"stdout","chunk":"x"}"# as &[u8],
                b"\r\n",
            ]
            .concat(),
        )
        .unwrap();
        assert!(
            index_run_log(&input, &output, limits())
                .unwrap_err()
                .to_string()
                .contains("carriage")
        );
    }
}
