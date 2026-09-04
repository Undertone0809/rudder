//! Bounded indexing for the local newline-delimited run-log format.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const INDEX_PROTOCOL_VERSION: u32 = 1;
pub const MAX_READ_BYTES: u64 = 1_000_000;

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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReadPage {
    pub content: String,
    pub end_offset: u64,
    pub eof: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

#[derive(Debug)]
pub struct ReadError {
    code: &'static str,
    source: Option<io::Error>,
}

impl ReadError {
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

impl std::fmt::Display for ReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|error| error as _)
    }
}

/// Read one bounded UTF-8 byte range without splitting a code point.
pub fn read_run_log_range(
    input: &Path,
    offset: u64,
    limit_bytes: u64,
) -> Result<EvidenceReadPage, ReadError> {
    if limit_bytes == 0 || limit_bytes > MAX_READ_BYTES {
        return Err(ReadError::new("evidence_read_limit_invalid"));
    }
    let metadata = fs::symlink_metadata(input)
        .map_err(|error| ReadError::io("evidence_read_not_found", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ReadError::new("evidence_read_input_invalid"));
    }
    let file_size = metadata.len();
    let start = offset.min(file_size);
    if start >= file_size {
        return Ok(EvidenceReadPage {
            content: String::new(),
            end_offset: start,
            eof: true,
            next_offset: None,
        });
    }

    let read_len = limit_bytes.max(4).min(file_size - start);
    let mut file =
        File::open(input).map_err(|error| ReadError::io("evidence_read_failed", error))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| ReadError::io("evidence_read_failed", error))?;
    let mut bytes = vec![0; read_len as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| ReadError::io("evidence_read_failed", error))?;

    let leading = bytes
        .iter()
        .take_while(|byte| (**byte & 0xc0) == 0x80)
        .count();
    let decodable = &bytes[leading..];
    let mut decoded = None;
    for trim in 0..=3.min(decodable.len()) {
        let candidate = &decodable[..decodable.len() - trim];
        if let Ok(content) = std::str::from_utf8(candidate) {
            decoded = Some((content.to_owned(), candidate.len()));
            break;
        }
    }
    let (content, decoded_bytes) =
        decoded.ok_or_else(|| ReadError::new("evidence_read_invalid_utf8"))?;
    let end_offset = start + leading as u64 + decoded_bytes as u64;
    let eof = end_offset >= file_size;
    Ok(EvidenceReadPage {
        content,
        end_offset,
        eof,
        next_offset: (!eof).then_some(end_offset),
    })
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
    use serde::Deserialize;
    use tempfile::tempdir;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReadFixture {
        source: String,
        cases: Vec<ReadFixtureCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReadFixtureCase {
        offset: u64,
        limit_bytes: u64,
        content: String,
        end_offset: u64,
        eof: bool,
        next_offset: Option<u64>,
    }

    fn limits() -> IndexLimits {
        IndexLimits {
            max_record_bytes: 1024,
            max_records: 10,
        }
    }

    #[test]
    fn reads_shared_utf8_byte_range_fixture() {
        let fixture: ReadFixture = serde_json::from_str(include_str!(
            "../../../fixtures/run-evidence-read-parity.json"
        ))
        .unwrap();
        let root = tempdir().unwrap();
        let input = root.path().join("run.log");
        std::fs::write(&input, fixture.source).unwrap();

        for case in fixture.cases {
            assert_eq!(
                read_run_log_range(&input, case.offset, case.limit_bytes).unwrap(),
                EvidenceReadPage {
                    content: case.content,
                    end_offset: case.end_offset,
                    eof: case.eof,
                    next_offset: case.next_offset,
                }
            );
        }
    }

    #[test]
    fn rejects_unsafe_inputs_limits_and_invalid_utf8() {
        let root = tempdir().unwrap();
        let input = root.path().join("run.log");
        std::fs::write(&input, [0xff, 0xfe, 0xfd, 0xfc]).unwrap();
        assert_eq!(
            read_run_log_range(&input, 0, 4).unwrap_err().code(),
            "evidence_read_invalid_utf8"
        );
        assert_eq!(
            read_run_log_range(&input, 0, 0).unwrap_err().code(),
            "evidence_read_limit_invalid"
        );
        assert_eq!(
            read_run_log_range(&input, 0, MAX_READ_BYTES + 1)
                .unwrap_err()
                .code(),
            "evidence_read_limit_invalid"
        );
        assert_eq!(
            read_run_log_range(root.path(), 0, 4).unwrap_err().code(),
            "evidence_read_input_invalid"
        );
        assert_eq!(
            read_run_log_range(&root.path().join("missing.log"), 0, 4)
                .unwrap_err()
                .code(),
            "evidence_read_not_found"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&input, root.path().join("run-link.log")).unwrap();
            assert_eq!(
                read_run_log_range(&root.path().join("run-link.log"), 0, 4)
                    .unwrap_err()
                    .code(),
                "evidence_read_input_invalid"
            );
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
