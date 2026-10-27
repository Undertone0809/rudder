use super::*;
use regex_lite::{Captures, Regex};
fn replace(input: &str, pattern: &str, replacement: &str) -> String {
    Regex::new(pattern)
        .expect("constant Messenger pattern")
        .replace_all(input, replacement)
        .into_owned()
}
fn entities(input: &str) -> String {
    let numeric = Regex::new(r"(?i)&#(x[0-9a-f]+|[0-9]+);").unwrap();
    let value = numeric.replace_all(input, |caps: &Captures<'_>| {
        let raw = &caps[1];
        let n = if raw.starts_with('x') || raw.starts_with('X') {
            u32::from_str_radix(&raw[1..], 16)
        } else {
            raw.parse()
        };
        n.ok()
            .and_then(char::from_u32)
            .map(|c| c.to_string())
            .unwrap_or_else(|| caps[0].to_owned())
    });
    Regex::new(r"(?i)&([a-z]+);")
        .unwrap()
        .replace_all(&value, |caps: &Captures<'_>| {
            match caps[1].to_ascii_lowercase().as_str() {
                "amp" => "&".into(),
                "apos" => "'".into(),
                "gt" => ">".into(),
                "lt" => "<".into(),
                "nbsp" => " ".into(),
                "quot" => "\"".into(),
                _ => caps[0].to_owned(),
            }
        })
        .into_owned()
}
fn heading(input: &str) -> Option<String> {
    let input = entities(input);
    let regex = Regex::new(r"^#{1,6}\s*(.*?)\s*#*$").unwrap();
    let found = regex.captures(&input)?;
    let text = found[1].trim().trim_end_matches([':', '：']).trim();
    (!text.is_empty()).then(|| text.to_owned())
}
fn line(input: &str) -> String {
    let mut value = entities(input).trim().to_owned();
    for (pattern, replacement) in [
        (r"^#{1,6}\s*(.*?)\s*#*$", "$1"),
        (r"^>\s*", ""),
        (r"^(?:[-*+]|[0-9]+[.)])\s+", ""),
        (r"^\[[ xX]\]\s+", ""),
        (r"!\[([^\]]*)\]\([^)]+\)", "$1"),
        (r"\[([^\]]+)\]\([^)]+\)", "$1"),
        (r"(?i)\[\s*((?:https?://|www\.)[^\]\s]+)\s*\]", "$1"),
        (r"`([^`]+)`", "$1"),
        (r"\*\*([^*]+)\*\*", "$1"),
        (r"__([^_]+)__", "$1"),
        (r"\*([^*]+)\*", "$1"),
        (r"_([^_]+)_", "$1"),
    ] {
        value = replace(&value, pattern, replacement)
    }
    let urls = Regex::new(r"(?i)(?:https?://|www\.)[^\s<>()\]]+").unwrap();
    let first = urls.find(&value).map(|m| m.as_str().to_owned());
    let plain = urls.replace_all(&value, " ");
    let plain = replace(&replace(&plain, r"\[\s*\]", " "), r"\(\s*\)", " ");
    let plain = replace(&plain, r"\s+", " ").trim().to_owned();
    if !plain.is_empty() {
        return plain;
    }
    first
        .and_then(|raw| {
            let raw = raw.trim_end_matches([
                ']', '.', ',', '!', '?', ';', ':', '，', '。', '！', '？', '；', '：',
            ]);
            let normalized = if raw.starts_with("www.") {
                format!("https://{raw}")
            } else {
                raw.into()
            };
            let url = url::Url::parse(&normalized).ok()?;
            let host = url.host_str()?.trim_start_matches("www.");
            let last = url
                .path_segments()?
                .rfind(|s| !s.trim().is_empty())
                .unwrap_or("");
            let last = replace(&replace(last, r"[-_]+", " "), r"(?i)\.html?$", "")
                .trim()
                .to_owned();
            Some(if last.is_empty() {
                host.into()
            } else {
                format!("{host} · {last}")
            })
        })
        .unwrap_or_default()
}
fn clip(input: String, max: usize) -> String {
    let chars = input.encode_utf16().collect::<Vec<_>>();
    if chars.len() <= max {
        input
    } else {
        format!(
            "{}…",
            String::from_utf16_lossy(&chars[..max.saturating_sub(1)])
        )
    }
}
pub(super) fn preview(value: Option<&str>, max: usize) -> Value {
    let lines = value
        .unwrap_or("")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let Some(first) = lines.first() else {
        return Value::Null;
    };
    let out = if let Some(head) = heading(first) {
        let head = line(&head);
        let detail = lines
            .iter()
            .skip(1)
            .map(|s| line(s))
            .find(|s| !s.is_empty());
        detail.map(|d| format!("{head}: {d}")).unwrap_or(head)
    } else {
        line(first)
    };
    if out.is_empty() {
        Value::Null
    } else {
        json!(clip(out, max))
    }
}
pub(super) fn title(value: &str) -> String {
    for raw in value.lines().map(str::trim).filter(|s| !s.is_empty()) {
        let out = line(&heading(raw).unwrap_or_else(|| raw.into()));
        if !out.is_empty() {
            return clip(out, 80);
        }
    }
    value.to_owned()
}
pub(super) fn short(prefix: &str, id: &str) -> String {
    format!(
        "{prefix}_{}",
        id.replace('-', "")
            .chars()
            .take(8)
            .collect::<String>()
            .to_ascii_lowercase()
    )
}
pub(super) fn redacted(value: &Value) -> Result<Value> {
    let raw = json!({"payload":value}).to_string();
    let raw = crate::request_reads::redaction::row(&raw, true)?;
    Ok(serde_json::from_str::<Value>(&raw)?["payload"].clone())
}
pub(super) fn detail(summary: &Value, description: &str, items: Vec<Value>) -> Value {
    let mut detail = summary.clone();
    detail["description"] = json!(description);
    detail["items"] = json!(items);
    detail
}
