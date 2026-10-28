//! Existing runtime-neutral message-owned visual envelopes. Private HTML is
//! written only as a generated Chat asset; placements contain no source code.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
const START: &str = ":::rudder-inline-visual:v1";
const END: &str = ":::rudder-inline-visual:end";
struct Line<'a> {
    start: usize,
    end: usize,
    content_end: usize,
    text: &'a str,
}
fn lines(body: &str) -> Vec<Line<'_>> {
    let mut result = Vec::new();
    let mut offset = 0;
    for text in body.split_inclusive('\n') {
        let end = offset + text.len();
        let content = text.strip_suffix('\n').unwrap_or(text);
        let content = content.strip_suffix('\r').unwrap_or(content);
        result.push(Line {
            start: offset,
            end,
            content_end: offset + content.len(),
            text: content,
        });
        offset = end;
    }
    result
}
fn fence_start(line: &str) -> Option<(char, usize)> {
    let count = line.chars().take_while(|c| *c == ' ').count();
    if count > 3 {
        return None;
    }
    let text = &line[count..];
    let marker = text.chars().next()?;
    if !matches!(marker, '`' | '~') {
        return None;
    }
    let n = text.chars().take_while(|c| *c == marker).count();
    if n < 3 || marker == '`' && text[n..].contains('`') {
        return None;
    }
    Some((marker, n))
}
fn closes(line: &str, fence: (char, usize)) -> bool {
    let text = line.trim_start_matches(' ');
    if line.len() - text.len() > 3 {
        return false;
    }
    let n = text.chars().take_while(|c| *c == fence.0).count();
    n >= fence.1 && text[n..].trim_matches([' ', '\t']).is_empty()
}
fn fragment_issue(fragment: &str) -> Option<&'static str> {
    let matches = |pattern: &str| {
        regex_lite::Regex::new(pattern)
            .expect("static visual pattern")
            .is_match(fragment)
    };
    if !matches(r#"(?i)<div\b[^>]*\bid\s*=\s*["']widget["'][^>]*>"#) {
        return Some("missing_widget");
    }
    if matches(
        r"(?i)</?(?:html|head|body|base|script|iframe|frame|object|embed|form|input|button|select|textarea|a|img|image|video|audio|source|link|meta)\b",
    ) || matches(
        r"(?i)\s(?:on[a-z]+|href|src|srcset|action|formaction|poster|data|xlink:href)\s*=",
    ) || matches(
        r"(?i)<style\b[^>]*>[\s\S]*?(?:@import|@font-face|url\s*\(|expression\s*\(|javascript:)[\s\S]*?</style>",
    ) {
        return Some("unsafe_fragment");
    }
    None
}
pub(super) fn capture(body: &str, reserved: usize) -> (String, Vec<Value>, Vec<Value>) {
    let source = lines(body);
    let mut index = 0;
    let mut fence = None;
    let mut live = 0;
    let mut total = 0;
    let mut replacements = Vec::new();
    let mut files = Vec::new();
    let mut mappings = Vec::new();
    while index < source.len() {
        let line = &source[index];
        if let Some(current) = fence {
            if closes(line.text, current) {
                fence = None
            }
            index += 1;
            continue;
        }
        let spaces = line.text.chars().take_while(|c| *c == ' ').count();
        if spaces >= 4
            || line.text.starts_with('\t')
            || line.text.trim_start_matches(' ').starts_with('>')
        {
            index += 1;
            continue;
        }
        if let Some(current) = fence_start(line.text) {
            fence = Some(current);
            index += 1;
            continue;
        }
        if line.text != START {
            index += 1;
            continue;
        }
        let slot = live + reserved;
        live += 1;
        let mut depth = 1;
        let mut nested = false;
        let mut close = None;
        for (candidate, next) in source.iter().enumerate().skip(index + 1) {
            if next.text == START {
                nested = true;
                depth += 1
            }
            if next.text == END {
                depth -= 1;
                if depth == 0 {
                    close = Some(candidate);
                    break;
                }
            }
        }
        let end = close.map(|i| source[i].content_end).unwrap_or(body.len());
        let fragment = close
            .map(|i| body[line.end..source[i].start].trim())
            .unwrap_or("");
        let reason = if nested {
            Some("nested")
        } else if close.is_none() {
            Some("unterminated")
        } else if slot >= 3 {
            Some("count_limit")
        } else if body.len() > 256 * 1024 {
            Some("reply_size_limit")
        } else if fragment.is_empty() {
            Some("empty")
        } else if fragment.len() > 64 * 1024 {
            Some("fragment_size_limit")
        } else if total + fragment.len() > 128 * 1024 {
            Some("total_size_limit")
        } else {
            fragment_issue(fragment)
        };
        let replacement = if slot < 3 {
            format!("::rudder-inline-vis{{slot=\"{slot}\"}}")
        } else {
            String::new()
        };
        replacements.push((line.start, end, replacement));
        if slot < 3 {
            let file = format!("inline-visual-{}.html", slot + 1);
            if let Some(reason) = reason {
                mappings.push(json!({"version":1,"slot":slot,"file":file,"status":"unavailable","reason":reason}));
            } else {
                total += fragment.len();
                mappings.push(json!({"version":1,"slot":slot,"file":file,"status":"captured","byteSize":fragment.len()}));
                files.push(json!({"source":"rudder_inline_visual","originalFilename":file,"contentType":"text/html","bodyBase64":STANDARD.encode(fragment.as_bytes()),"slot":slot}));
            }
        }
        if let Some(close) = close {
            index = close + 1
        } else {
            break;
        }
    }
    let mut output = body.to_owned();
    for (mut start, mut end, replacement) in replacements.into_iter().rev() {
        let line_start = output[..start].rfind('\n').map_or(0, |v| v + 1);
        let line_end = output[end..].find('\n').map_or(output.len(), |v| end + v);
        if output[line_start..start].trim().is_empty() && output[end..line_end].trim().is_empty() {
            start = line_start;
            end = if line_end < output.len() {
                line_end + 1
            } else {
                line_end
            };
        }
        let newline = end > 0 && output.as_bytes()[end - 1] == b'\n' && !replacement.is_empty();
        let replacement = if newline {
            format!("{replacement}\n")
        } else {
            replacement
        };
        output.replace_range(start..end, &replacement);
    }
    (output.trim().into(), files, mappings)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visual_capture_preserves_code_and_rejects_active_html() {
        let source = "Before\n:::rudder-inline-visual:v1\n<div id=\"widget\">Hello 🧭</div>\n:::rudder-inline-visual:end\nAfter";
        let (body, files, mappings) = capture(source, 0);
        assert_eq!(body, "Before\n::rudder-inline-vis{slot=\"0\"}\nAfter");
        assert_eq!(files.len(), 1);
        assert_eq!(mappings[0]["status"], "captured");
        assert_eq!(capture(&format!("```html\n{source}\n```"), 0).1.len(), 0);
        let (_, files, mappings) =
            capture(&source.replace("Hello 🧭", "<script>bad()</script>"), 0);
        assert!(files.is_empty());
        assert_eq!(mappings[0]["reason"], "unsafe_fragment");
    }
}

/// Legacy Codex HTML files are scoped to this provider thread/date and the
/// actual invocation time window; no arbitrary assistant path is opened.
pub(super) fn capture_codex(
    body: &str,
    home: Option<&str>,
    thread: Option<&str>,
    started: i64,
    ended: i64,
) -> (Vec<Value>, Vec<Value>) {
    let source = lines(body);
    let mut fence = None;
    let mut directives = Vec::new();
    let attribute =
        regex_lite::Regex::new(r#"^file\s*=\s*"([^"]*)"\s*$"#).expect("static Codex attribute");
    for line in source {
        let trimmed = line.text.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = &trimmed[..3];
            if fence == Some(marker) {
                fence = None
            } else if fence.is_none() {
                fence = Some(marker)
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let line = line.text.trim();
        let Some(raw) = line
            .strip_prefix("::codex-inline-vis{")
            .and_then(|v| v.strip_suffix('}'))
        else {
            continue;
        };
        let Some(capture) = attribute.captures(raw.trim()) else {
            continue;
        };
        let file = &capture[1];
        if file.len() <= 5
            || file.len() > 255
            || !file.ends_with(".html")
            || !file
                .bytes()
                .next()
                .is_some_and(|v| v.is_ascii_alphanumeric())
            || !file
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"._-".contains(&v))
        {
            continue;
        }
        if directives.len() < 3 {
            directives.push(file.to_owned())
        }
    }
    let directory = thread_directory(home, thread, started, ended);
    let mut files = Vec::new();
    let mut mappings = Vec::new();
    for (index, file) in directives.into_iter().enumerate() {
        let captured = match &directory {
            Ok(root) => read_visual(root, &file, started, ended),
            Err(reason) => Err(*reason),
        };
        match captured {
            Ok(body) => {
                mappings.push(json!({"directiveIndex":index,"file":file,"status":"captured"}));
                files.push(json!({"source":"codex_inline_visual","originalFilename":file,"contentType":"text/html","bodyBase64":STANDARD.encode(body),"directiveIndex":index}));
            }
            Err(reason) => mappings.push(
                json!({"directiveIndex":index,"file":file,"status":"unavailable","reason":reason}),
            ),
        }
    }
    (files, mappings)
}
fn thread_directory(
    home: Option<&str>,
    thread: Option<&str>,
    started: i64,
    ended: i64,
) -> Result<std::path::PathBuf, &'static str> {
    let home = home.ok_or("missing")?;
    let thread = thread.ok_or("missing")?;
    if thread.is_empty()
        || thread.len() > 128
        || !thread
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'-')
    {
        return Err("path_escape");
    }
    let home = std::fs::canonicalize(home).map_err(|_| "missing")?;
    let root = std::fs::canonicalize(home.join("visualizations")).map_err(|_| "missing")?;
    if !root.starts_with(&home) || root == home {
        return Err("path_escape");
    }
    let local = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    let mut dates = std::collections::BTreeSet::new();
    for stamp in [started, ended] {
        for offset in [local, time::UtcOffset::UTC] {
            if let Ok(date) =
                time::OffsetDateTime::from_unix_timestamp_nanos(stamp as i128 * 1_000_000)
            {
                let date = date.to_offset(offset);
                dates.insert(format!(
                    "{:04}/{:02}/{:02}",
                    date.year(),
                    date.month() as u8,
                    date.day()
                ));
            }
        }
    }
    for date in dates {
        let candidate = root.join(date).join(thread);
        if let Ok(real) = std::fs::canonicalize(&candidate) {
            if !real.starts_with(&root)
                || real == root
                || real.file_name().and_then(|v| v.to_str()) != Some(thread)
            {
                return Err("path_escape");
            }
            let metadata = std::fs::symlink_metadata(candidate).map_err(|_| "missing")?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("path_escape");
            }
            return Ok(real);
        }
    }
    Err("missing")
}
fn read_visual(
    root: &std::path::Path,
    file: &str,
    started: i64,
    ended: i64,
) -> Result<Vec<u8>, &'static str> {
    use std::io::Read;
    let path = std::fs::canonicalize(root.join(file)).map_err(|_| "missing")?;
    if !path.starts_with(root) || path == root {
        return Err("path_escape");
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path).map_err(|_| "unreadable")?;
    let metadata = file.metadata().map_err(|_| "unreadable")?;
    if !metadata.is_file() {
        return Err("unreadable");
    }
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("too_large");
    }
    let modified = metadata
        .modified()
        .map_err(|_| "unreadable")?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "out_of_window")?
        .as_millis() as i64;
    if modified < started.min(ended) - 5000 || modified > started.max(ended) + 5000 {
        return Err("out_of_window");
    }
    let current_path = std::fs::canonicalize(&path).map_err(|_| "path_escape")?;
    let current = std::fs::metadata(&current_path).map_err(|_| "path_escape")?;
    if !current_path.starts_with(root) {
        return Err("path_escape");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
            return Err("path_escape");
        }
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("too_large");
    }
    let after = file.metadata().map_err(|_| "unreadable")?;
    if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
        return Err("unreadable");
    }
    Ok(bytes)
}
