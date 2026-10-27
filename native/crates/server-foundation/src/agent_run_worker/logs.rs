//! Existing local_file Run-log format and native evidence index.
use rudder_d1_persistence::agent_execution::{AgentRunObserver, output};
use rudder_native_chat_executor::agent_run::{AgentRunStream, parse_agent_stdout_line};
use rudder_run_evidence_core::{IndexLimits, index_run_log};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    fs::{File, OpenOptions},
    io::{BufReader, Read, Write},
    path::PathBuf,
};

pub(super) struct RunLogs {
    path: PathBuf,
    file: File,
    runtime: String,
    owner: AgentRunObserver,
    stdout: Stream,
    stderr: Stream,
    secrets: Vec<String>,
    pub transcript: Vec<Value>,
}
#[derive(Default)]
struct Stream {
    bytes: Vec<u8>,
    pending: String,
    line: String,
    excerpt: String,
    next: u64,
}
impl RunLogs {
    pub async fn begin(
        pool: &PgPool,
        owner: AgentRunObserver,
        runtime: &str,
        instance_root: &str,
    ) -> Result<Self, String> {
        let root = std::env::var_os("RUN_LOG_BASE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(instance_root).join("data/run-logs"));
        let reference = format!(
            "{}/{}/{}.ndjson",
            owner.organization_id(),
            owner.agent_id(),
            owner.run_id()
        );
        let path = root.join(&reference);
        std::fs::create_dir_all(path.parent().ok_or("Run log path is invalid")?)
            .map_err(|e| e.to_string())?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        output::begin_log(pool, &owner, &reference)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self {
            path,
            file,
            runtime: runtime.into(),
            owner,
            stdout: Stream::default(),
            stderr: Stream::default(),
            secrets: Vec::new(),
            transcript: Vec::new(),
        })
    }
    pub fn set_secrets(&mut self, values: Vec<String>) {
        self.secrets = values.into_iter().filter(|s| !s.is_empty()).collect();
        self.secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    }
    pub fn redact_value(&self, value: &mut Value) {
        match value {
            Value::String(text) => {
                for secret in &self.secrets {
                    *text = text.replace(secret, "***REDACTED***");
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.redact_value(value)
                }
            }
            Value::Object(fields) => {
                for value in fields.values_mut() {
                    self.redact_value(value)
                }
            }
            _ => {}
        }
    }
    pub fn provider_bytes(
        &mut self,
        stream: AgentRunStream,
        offset: u64,
        chunk: Vec<u8>,
    ) -> Result<(), String> {
        let target = match stream {
            AgentRunStream::Stdout => &mut self.stdout,
            AgentRunStream::Stderr => &mut self.stderr,
        };
        if offset < target.next {
            return Ok(());
        }
        if offset != target.next {
            return Err("Runtime log stream lost byte continuity".into());
        }
        target.next += chunk.len() as u64;
        target.bytes.extend(chunk);
        let valid = match std::str::from_utf8(&target.bytes) {
            Ok(_) => target.bytes.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => target.bytes.len(),
        };
        let text = String::from_utf8_lossy(&target.bytes[..valid]).into_owned();
        target.bytes.drain(..valid);
        target.pending.push_str(&text);
        for secret in &self.secrets {
            target.pending = target.pending.replace(secret, "***REDACTED***");
        }
        let retain = self.secrets.iter().map(String::len).max().unwrap_or(0);
        let mut emit = target.pending.len().saturating_sub(retain);
        while !target.pending.is_char_boundary(emit) {
            emit -= 1;
        }
        let chunk = target.pending[..emit].to_owned();
        target.pending.drain(..emit);
        self.write(
            if stream == AgentRunStream::Stdout {
                "stdout"
            } else {
                "stderr"
            },
            &chunk,
        )
    }
    pub fn context_log(&mut self, event: &Value) -> Result<(), String> {
        self.write(
            event["stream"].as_str().unwrap_or("system"),
            event["chunk"].as_str().unwrap_or(""),
        )
    }
    fn write(&mut self, stream: &str, chunk: &str) -> Result<(), String> {
        if chunk.is_empty() {
            return Ok(());
        }
        let ts = now();
        let row = json!({"ts":ts,"stream":stream,"chunk":chunk});
        serde_json::to_writer(&mut self.file, &row).map_err(|e| e.to_string())?;
        self.file.write_all(b"\n").map_err(|e| e.to_string())?;
        let target = if stream == "stdout" {
            &mut self.stdout
        } else {
            &mut self.stderr
        };
        target.excerpt.push_str(chunk);
        if target.excerpt.chars().count() > 8192 {
            target.excerpt = target
                .excerpt
                .chars()
                .rev()
                .take(8192)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
        }
        if stream == "stdout" {
            target.line.push_str(chunk);
            while let Some(end) = target.line.find('\n') {
                let line = target.line.drain(..=end).collect::<String>();
                self.transcript
                    .extend(parse_agent_stdout_line(&self.runtime, &line, &ts));
            }
        }
        Ok(())
    }
    pub async fn finish(&mut self, pool: &PgPool) -> Result<(), String> {
        for stream in [AgentRunStream::Stdout, AgentRunStream::Stderr] {
            let target = if stream == AgentRunStream::Stdout {
                &mut self.stdout
            } else {
                &mut self.stderr
            };
            target
                .pending
                .push_str(&String::from_utf8_lossy(&target.bytes));
            target.bytes.clear();
            for secret in &self.secrets {
                target.pending = target.pending.replace(secret, "***REDACTED***");
            }
            let pending = std::mem::take(&mut target.pending);
            self.write(
                if stream == AgentRunStream::Stdout {
                    "stdout"
                } else {
                    "stderr"
                },
                &pending,
            )?;
        }
        if !self.stdout.line.is_empty() {
            self.transcript.extend(parse_agent_stdout_line(
                &self.runtime,
                &std::mem::take(&mut self.stdout.line),
                &now(),
            ));
        }
        self.file.flush().map_err(|e| e.to_string())?;
        let bytes = std::fs::metadata(&self.path)
            .map_err(|e| e.to_string())?
            .len();
        let mut hash = Sha256::new();
        let mut reader = BufReader::new(File::open(&self.path).map_err(|e| e.to_string())?);
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        let sha = format!("{:x}", hash.finalize());
        index_run_log(
            &self.path,
            &PathBuf::from(format!("{}.index.ndjson", self.path.display())),
            IndexLimits {
                max_record_bytes: 8 * 1024 * 1024,
                max_records: 10_000_000,
            },
        )
        .map_err(|e| e.to_string())?;
        output::finish_log(
            pool,
            &self.owner,
            i64::try_from(bytes).unwrap_or(i64::MAX),
            &sha,
            &self.stdout.excerpt,
            &self.stderr.excerpt,
        )
        .await
        .map_err(|e| e.to_string())
    }
}
pub(super) fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}
