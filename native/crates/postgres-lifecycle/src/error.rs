use crate::protocol::PROTOCOL_SCHEMA;
use serde::Serialize;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

const MAX_POSTGRES_DIAGNOSTIC_BYTES: usize = 8 * 1024;

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub schema: &'static str,
    pub op: &'static str,
    pub code: String,
    pub message: String,
}

#[derive(Debug)]
pub struct OwnerError {
    pub code: &'static str,
    pub message: String,
}

impl OwnerError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn io(code: &'static str, context: &str, error: io::Error) -> Self {
        Self::new(code, format!("{context}: {}", error.kind()))
    }

    pub(crate) fn with_diagnostic_file(mut self, file: &mut File, secrets: &[&str]) -> Self {
        if let Ok(Some(diagnostic)) = read_diagnostic_tail(file, secrets) {
            self.message
                .push_str("\nRecent PostgreSQL startup output:\n");
            self.message.push_str(&diagnostic);
        }
        self
    }

    pub(crate) fn with_diagnostic_path(mut self, path: &Path, secrets: &[&str]) -> Self {
        if let Ok(mut file) = File::open(path) {
            self = self.with_diagnostic_file(&mut file, secrets);
        }
        self
    }

    pub(crate) fn response(&self) -> ErrorResponse {
        ErrorResponse {
            schema: PROTOCOL_SCHEMA,
            op: "error",
            code: self.code.to_owned(),
            message: self.message.clone(),
        }
    }
}

fn read_diagnostic_tail(file: &mut File, secrets: &[&str]) -> io::Result<Option<String>> {
    let length = file.seek(SeekFrom::End(0))?;
    let start = length.saturating_sub(MAX_POSTGRES_DIAGNOSTIC_BYTES as u64);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    (&mut *file)
        .take(MAX_POSTGRES_DIAGNOSTIC_BYTES as u64)
        .read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0
        && let Some(newline) = text.find('\n')
    {
        text = text[newline + 1..].to_owned();
    }
    for secret in secrets {
        if !secret.is_empty() {
            text = text.replace(secret, "[REDACTED]");
        }
    }
    text = redact_postgres_urls(&text);
    for key in [
        "password",
        "passwd",
        "secret",
        "token",
        "credential",
        "authorization",
        "api_key",
        "access_token",
    ] {
        text = redact_key_value(&text, key);
    }
    text = redact_bearer_tokens(&text);
    text = text
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect();
    if text.trim().is_empty() {
        return Ok(None);
    }
    if text.len() > MAX_POSTGRES_DIAGNOSTIC_BYTES {
        let mut start = text.len() - MAX_POSTGRES_DIAGNOSTIC_BYTES;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text = text[start..].to_owned();
    }
    Ok(Some(text))
}

fn redact_key_value(text: &str, key: &str) -> String {
    let needle = key.to_ascii_lowercase();
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut copied = 0;
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&needle) {
        let start = cursor + relative;
        let key_end = start + needle.len();
        let has_boundary = text[..start]
            .chars()
            .next_back()
            .is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_');
        if !has_boundary {
            cursor = key_end;
            continue;
        }

        let mut value_start = key_end;
        while bytes
            .get(value_start)
            .is_some_and(|byte| byte.is_ascii_whitespace() && !matches!(*byte, b'\n' | b'\r'))
        {
            value_start += 1;
        }
        if !bytes
            .get(value_start)
            .is_some_and(|byte| matches!(*byte, b'=' | b':'))
        {
            cursor = key_end;
            continue;
        }
        value_start += 1;
        while bytes
            .get(value_start)
            .is_some_and(|byte| byte.is_ascii_whitespace() && !matches!(*byte, b'\n' | b'\r'))
        {
            value_start += 1;
        }

        let mut value_end = value_start;
        while bytes
            .get(value_end)
            .is_some_and(|byte| !matches!(*byte, b'\n' | b'\r'))
        {
            value_end += 1;
        }
        output.push_str(&text[copied..value_start]);
        if value_end > value_start {
            output.push_str("[REDACTED]");
        }
        copied = value_end;
        cursor = value_end.max(key_end);
    }
    output.push_str(&text[copied..]);
    output
}

fn redact_postgres_urls(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut output = String::with_capacity(text.len());
    let mut copied = 0;
    let mut cursor = 0;
    while cursor < text.len() {
        let tail = &lower[cursor..];
        let postgres = tail
            .find("postgres://")
            .map(|offset| (offset, "postgres://"));
        let postgresql = tail
            .find("postgresql://")
            .map(|offset| (offset, "postgresql://"));
        let found = match (postgres, postgresql) {
            (Some(left), Some(right)) => Some(if left.0 < right.0 { left } else { right }),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        };
        let Some((offset, scheme)) = found else {
            break;
        };
        let start = cursor + offset;
        let after_scheme = start + scheme.len();
        let mut boundary = after_scheme;
        while bytes_at(text, boundary).is_some_and(|byte| {
            !byte.is_ascii_whitespace() && !matches!(byte, b'/' | b'?' | b'#' | b'\n' | b'\r')
        }) {
            boundary += 1;
        }
        let at = text[after_scheme..boundary]
            .find('@')
            .map(|value| after_scheme + value);
        output.push_str(&text[copied..after_scheme]);
        if let Some(at) = at {
            output.push_str("[REDACTED]@");
            copied = at + 1;
            cursor = copied;
        } else {
            copied = after_scheme;
            cursor = after_scheme;
        }
    }
    output.push_str(&text[copied..]);
    output
}

fn bytes_at(text: &str, index: usize) -> Option<u8> {
    text.as_bytes().get(index).copied()
}

fn redact_bearer_tokens(text: &str) -> String {
    let needle = "bearer";
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut copied = 0;
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(needle) {
        let start = cursor + relative;
        let end = start + needle.len();
        let boundary = text[..start]
            .chars()
            .next_back()
            .is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_');
        if !boundary
            || !bytes
                .get(end)
                .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
        {
            cursor = end;
            continue;
        }
        let mut token_start = end;
        while bytes
            .get(token_start)
            .is_some_and(|byte| matches!(*byte, b' ' | b'\t'))
        {
            token_start += 1;
        }
        let mut token_end = token_start;
        while bytes.get(token_end).is_some_and(|byte| {
            !byte.is_ascii_whitespace() && !matches!(*byte, b',' | b';' | b')' | b']' | b'}')
        }) {
            token_end += 1;
        }
        if token_end == token_start {
            cursor = end;
            continue;
        }
        output.push_str(&text[copied..token_start]);
        output.push_str("[REDACTED]");
        copied = token_end;
        cursor = token_end;
    }
    output.push_str(&text[copied..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn diagnostic_tail_keeps_the_final_unterminated_line() {
        let mut file = tempfile::tempfile().unwrap();
        write!(file, "startup\nFATAL: last diagnostic without newline").unwrap();

        let tail = read_diagnostic_tail(&mut file, &[]).unwrap().unwrap();

        assert!(tail.ends_with("FATAL: last diagnostic without newline"));
    }

    #[test]
    fn diagnostic_tail_is_bounded_and_redacts_credentials() {
        let mut file = tempfile::tempfile().unwrap();
        write!(file, "{}", "old output line\n".repeat(1000)).unwrap();
        write!(
            file,
            "FATAL password=initdb-secret\nFATAL bearer api-secret\nFATAL postgres://rudder:db-secret@localhost/db"
        )
        .unwrap();

        let tail = read_diagnostic_tail(&mut file, &["initdb-secret"])
            .unwrap()
            .unwrap();

        assert!(tail.len() <= MAX_POSTGRES_DIAGNOSTIC_BYTES);
        assert!(tail.contains("FATAL"));
        assert!(tail.contains("password=[REDACTED]"));
        assert!(tail.contains("bearer [REDACTED]"));
        assert!(tail.contains("postgres://[REDACTED]@localhost/db"));
        assert!(!tail.contains("initdb-secret"));
        assert!(!tail.contains("api-secret"));
        assert!(!tail.contains("db-secret"));
    }

    #[test]
    fn diagnostic_tail_redacts_mixed_case_authorization_bearer_values() {
        let mut file = tempfile::tempfile().unwrap();
        write!(
            file,
            "aUtHoRiZaTiOn: Bearer \"quoted-token-secret\"\n\
             Authorization: Basic auth-basic-secret\n\
             Authorization: \"Bearer quoted-header-secret\"\n\
             Authorization: \"Basic quoted-basic-secret\"\n\
             Authorization: \"Bearer escaped-\\\"quoted-header-secret\\\"\"\n\
             token: Bearer nested-token-secret\n\
             credential: Bearer nested-credential-secret\n\
             token: Basic nested-token-basic-secret\n\
             credential: Basic nested-credential-basic-secret\n\
             credential: CustomScheme arbitrary-two-token-secret extra-value\n\
             token:\n\
             FATAL: diagnostic after empty credential assignment\n\
             Bearer\n\
             FATAL: final diagnostic without newline"
        )
        .unwrap();

        let tail = read_diagnostic_tail(&mut file, &[]).unwrap().unwrap();

        assert!(!tail.contains("quoted-token-secret"));
        assert!(!tail.contains("auth-basic-secret"));
        assert!(!tail.contains("quoted-header-secret"));
        assert!(!tail.contains("quoted-basic-secret"));
        assert!(!tail.contains("escaped-quoted-header-secret"));
        assert!(!tail.contains("nested-token-secret"));
        assert!(!tail.contains("nested-credential-secret"));
        assert!(!tail.contains("nested-token-basic-secret"));
        assert!(!tail.contains("nested-credential-basic-secret"));
        assert!(!tail.contains("arbitrary-two-token-secret"));
        assert!(tail.contains("FATAL: diagnostic after empty credential assignment"));
        assert!(tail.ends_with("FATAL: final diagnostic without newline"));
    }
}
