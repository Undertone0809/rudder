//! Display-only projection of Hermes' public ACP tool content. Raw arguments,
//! raw output, resource bytes and private protocol metadata are never copied.
use crate::rpc::{HermesProgressKind, HermesTransportError};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

const MAX_TEXT: usize = 12 * 1024;
const MAX_PATH: usize = 2048;
const MAX_CALLS: usize = 512;
const TRUNCATED: &str = "\n… Tool details truncated.";

#[derive(Default)]
pub(crate) struct ToolProgress {
    calls: BTreeMap<String, Snapshot>,
}
struct Snapshot {
    name: String,
    input: Value,
    status: String,
    content: String,
}
impl ToolProgress {
    pub(crate) fn normalize(
        &mut self,
        update: &Value,
        id: String,
        is_start: bool,
    ) -> Result<Vec<HermesProgressKind>, HermesTransportError> {
        let supplied_status = update.get("status").and_then(Value::as_str);
        if supplied_status.is_some_and(|status| {
            !matches!(status, "pending" | "in_progress" | "completed" | "failed")
        }) {
            return Err(HermesTransportError::InvalidMessage);
        }
        let is_new = !self.calls.contains_key(&id);
        if is_new && self.calls.len() >= MAX_CALLS {
            return Ok(vec![HermesProgressKind::Truncated]);
        }
        let mut events = Vec::new();
        if is_start || is_new {
            let title = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Tool");
            let (name, input) = request(update, title, is_start);
            let prior = self.calls.remove(&id);
            self.calls.insert(
                id.clone(),
                Snapshot {
                    name,
                    input,
                    status: prior
                        .as_ref()
                        .map(|p| p.status.clone())
                        .unwrap_or_else(|| "in_progress".into()),
                    content: prior.map(|p| p.content).unwrap_or_default(),
                },
            );
            let snapshot = &self.calls[&id];
            events.push(HermesProgressKind::ToolCall {
                tool_call_id: id.clone(),
                title: snapshot.name.clone(),
                input: snapshot.input.clone(),
            });
        }
        let snapshot = self.calls.get_mut(&id).expect("call inserted above");
        if !is_start {
            // ACP updates are patches. Missing content/status preserves the last
            // snapshot; an explicit empty content array clears the output.
            let old_input = snapshot.input.clone();
            add_location(&mut snapshot.input, update, true);
            if old_input != snapshot.input {
                events.push(HermesProgressKind::ToolCall {
                    tool_call_id: id.clone(),
                    title: snapshot.name.clone(),
                    input: snapshot.input.clone(),
                });
            }
            if update.get("content").and_then(Value::as_array).is_some() {
                snapshot.content = public_content(update);
            }
            if let Some(status) = supplied_status {
                snapshot.status = status.into();
            }
            events.push(HermesProgressKind::ToolCallUpdate {
                tool_call_id: id,
                status: snapshot.status.clone(),
                content: snapshot.content.clone(),
            });
        } else if let Some(status) = supplied_status {
            snapshot.status = status.into();
            // A completed initial upsert must not leave a spinner behind.
            if matches!(status, "completed" | "failed") {
                events.push(HermesProgressKind::ToolCallUpdate {
                    tool_call_id: id,
                    status: status.into(),
                    content: String::new(),
                });
            }
        }
        Ok(events)
    }
}

fn bounded(text: &str, limit: usize) -> String {
    let mut result = String::new();
    for c in text.chars() {
        if c.is_control() && c != '\n' && c != '\t' {
            continue;
        }
        if result.len() + c.len_utf8() > limit {
            while result.len() + TRUNCATED.len() > limit {
                result.pop();
            }
            result.push_str(TRUNCATED);
            break;
        }
        result.push(c);
    }
    result
}

fn insert(input: &mut Map<String, Value>, key: &str, text: &str) {
    if !text.trim().is_empty() {
        input.insert(
            key.into(),
            Value::String(bounded(
                text.trim(),
                if key == "path" { MAX_PATH } else { MAX_TEXT },
            )),
        );
    }
}
fn request(update: &Value, title: &str, include_content: bool) -> (String, Value) {
    let title = title.trim();
    let text = if include_content {
        public_content(update)
    } else {
        String::new()
    };
    let mut input = Map::new();
    let name = if let Some(query) = title.strip_prefix("web search:") {
        insert(
            &mut input,
            "query",
            text.strip_prefix("Searching the web for:").unwrap_or(query),
        );
        "web_search"
    } else if let Some(command) = title.strip_prefix("terminal:") {
        insert(
            &mut input,
            "command",
            text.strip_prefix("$ ").unwrap_or(command),
        );
        "terminal"
    } else if title.starts_with("python:") || title == "python code" || title == "execute_code" {
        let fence = char::from(96).to_string().repeat(3);
        if let Some((_, body)) = text.split_once(&format!("{fence}python\n")) {
            insert(
                &mut input,
                "code",
                body.rsplit_once(&fence).map(|p| p.0).unwrap_or(body),
            );
        } else {
            insert(&mut input, "details", &text);
        }
        "execute_code"
    } else if let Some(path) = title.strip_prefix("read:") {
        insert(&mut input, "path", path);
        insert(&mut input, "details", &text);
        "read_file"
    } else if let Some(path) = title.strip_prefix("write:") {
        insert(&mut input, "path", path);
        insert(&mut input, "details", &text);
        "write_file"
    } else if title.starts_with("patch (") {
        if let Some((_, path)) = title.split_once("):") {
            insert(&mut input, "path", path);
        }
        insert(&mut input, "details", &text);
        "patch"
    } else if let Some(query) = title.strip_prefix("search:") {
        insert(&mut input, "query", query);
        insert(&mut input, "details", &text);
        "search_files"
    } else if let Some(url) = title.strip_prefix("extract:") {
        // Hermes' title exposes only the first URL for a multi-URL extraction.
        insert(&mut input, "url", url.split(" (+").next().unwrap_or(url));
        "web_extract"
    } else if title == "web extract" {
        "web_extract"
    } else {
        insert(&mut input, "details", &text);
        // Unknown/plugin tool names remain labels; no arbitrary rawInput fields
        // are trusted as known-tool arguments.
        title
    };
    let mut input = Value::Object(input);
    add_location(&mut input, update, false);
    (bounded(name, 1024), input)
}
fn add_location(input: &mut Value, update: &Value, clear_empty: bool) {
    let Some(locations) = update.get("locations").and_then(Value::as_array) else {
        return;
    };
    let Some(path) = locations
        .iter()
        .find_map(|v| v.get("path").and_then(Value::as_str))
    else {
        if clear_empty {
            input
                .as_object_mut()
                .expect("typed input object")
                .remove("path");
        }
        return;
    };
    if !path.is_empty() {
        input
            .as_object_mut()
            .expect("typed input object")
            .insert("path".into(), Value::String(bounded(path, MAX_PATH)));
    }
}
fn public_content(update: &Value) -> String {
    let Some(blocks) = update.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    let mut parts = Vec::new();
    let mut used = 0;
    for block in blocks.iter().take(64) {
        let part = match block.get("type").and_then(Value::as_str) {
            Some("content")
                if block.pointer("/content/type").and_then(Value::as_str) == Some("text") =>
            {
                block
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .map(|s| bounded(s, MAX_TEXT))
            }
            Some("diff") => {
                let path = block.get("path").and_then(Value::as_str).unwrap_or("");
                let old = block.get("oldText").and_then(Value::as_str).unwrap_or("");
                let new = block.get("newText").and_then(Value::as_str).unwrap_or("");
                Some(format!(
                    "File: {}\nBefore:\n{}\nAfter:\n{}",
                    bounded(path, MAX_PATH),
                    bounded(old, MAX_TEXT),
                    bounded(new, MAX_TEXT)
                ))
            }
            _ => None,
        };
        if let Some(part) = part {
            used += part.len();
            parts.push(part);
            if used >= MAX_TEXT {
                break;
            }
        }
    }
    bounded(&parts.join("\n\n"), MAX_TEXT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn text(value: &str) -> Value {
        json!({"type":"content","content":{"type":"text","text":value}})
    }
    #[test]
    fn projects_known_public_tool_requests_without_private_raw_fields() {
        let mut state = ToolProgress::default();
        for (id, title, content, locations, name, key, expected) in [
            (
                "a",
                "read: preview",
                Vec::new(),
                json!([{"path":"/tmp/report.txt","private":"hidden"}]),
                "read_file",
                "path",
                "/tmp/report.txt",
            ),
            (
                "b",
                "web search: AI news",
                vec![text("Searching the web for: AI news")],
                json!([]),
                "web_search",
                "query",
                "AI news",
            ),
            (
                "c",
                "terminal: printf marker",
                vec![text("$ printf marker")],
                json!([]),
                "terminal",
                "command",
                "printf marker",
            ),
            (
                "d",
                "python: from hermes_tools import terminal",
                vec![text(
                    "Running Python helper script:\n\n\u{0060}\u{0060}\u{0060}python\nprint(42)\n\u{0060}\u{0060}\u{0060}",
                )],
                json!([]),
                "execute_code",
                "code",
                "print(42)",
            ),
        ] {
            let result=state.normalize(&json!({"title":title,"content":content,"locations":locations,"rawInput":{"secret":"PRIVATE"},"env":{"TOKEN":"PRIVATE"}}),id.into(),true).unwrap();
            match &result[0] {
                HermesProgressKind::ToolCall { title, input, .. } => {
                    assert_eq!(title, name);
                    assert_eq!(input[key], expected);
                    assert!(!input.to_string().contains("PRIVATE"));
                }
                _ => panic!("tool request"),
            }
        }
    }
    #[test]
    fn preserves_initial_title_path_with_empty_locations_then_applies_explicit_clear() {
        let mut state = ToolProgress::default();
        let call = state
            .normalize(
                &json!({"title":"read: /tmp/report.txt","locations":[]}),
                "a".into(),
                true,
            )
            .unwrap();
        assert!(
            matches!(&call[0], HermesProgressKind::ToolCall {input,..} if input["path"] == "/tmp/report.txt")
        );
        let cleared = state
            .normalize(&json!({"locations":[]}), "a".into(), false)
            .unwrap();
        assert!(
            matches!(&cleared[0], HermesProgressKind::ToolCall {input,..} if input.get("path").is_none())
        );
    }
    #[test]
    fn folds_partial_updates_and_interleaved_ids_without_fabricating_completion() {
        let mut state = ToolProgress::default();
        for id in ["a", "b"] {
            state
                .normalize(&json!({"title":"Tool"}), id.into(), true)
                .unwrap();
        }
        let update = state
            .normalize(&json!({"content":[text("partial A")]}), "a".into(), false)
            .unwrap();
        assert!(
            matches!(&update[0],HermesProgressKind::ToolCallUpdate {status,content,..} if status=="in_progress" && content=="partial A")
        );
        let b = state
            .normalize(
                &json!({"status":"failed","content":[text("B failed")]}),
                "b".into(),
                false,
            )
            .unwrap();
        assert!(
            matches!(&b[0],HermesProgressKind::ToolCallUpdate {tool_call_id,status,content} if tool_call_id=="b" && status=="failed" && content=="B failed")
        );
        let final_a = state
            .normalize(
                &json!({"status":"completed","rawOutput":"PRIVATE"}),
                "a".into(),
                false,
            )
            .unwrap();
        assert!(
            matches!(&final_a[0],HermesProgressKind::ToolCallUpdate {status,content,..} if status=="completed" && content=="partial A")
        );
        let empty = state
            .normalize(&json!({"content":[]}), "a".into(), false)
            .unwrap();
        assert!(
            matches!(&empty[0],HermesProgressKind::ToolCallUpdate {status,content,..} if status=="completed" && content.is_empty())
        );
        state
            .normalize(
                &json!({"locations":[{"path":"/tmp/old"}]}),
                "a".into(),
                false,
            )
            .unwrap();
        let cleared = state
            .normalize(&json!({"locations":[]}), "a".into(), false)
            .unwrap();
        assert!(
            matches!(&cleared[0], HermesProgressKind::ToolCall {input,..} if input.get("path").is_none())
        );
        let unknown = state
            .normalize(
                &json!({"status":"completed","content":[text("other")]}),
                "c".into(),
                false,
            )
            .unwrap();
        assert_eq!(unknown.len(), 2);
        assert!(
            matches!(&unknown[0],HermesProgressKind::ToolCall {tool_call_id,..} if tool_call_id=="c")
        );
    }
    #[test]
    fn bounds_public_unicode_details_and_ignores_resources_and_raw_payloads() {
        let mut state = ToolProgress::default();
        let content = format!("{}END", "字".repeat(MAX_TEXT));
        let updates=state.normalize(&json!({"content":[text(&content),{"type":"content","content":{"type":"image","data":"PRIVATE"}}],"status":"completed","rawOutput":"PRIVATE"}),"a".into(),false).unwrap();
        assert!(
            matches!(&updates[1],HermesProgressKind::ToolCallUpdate {content,..} if content.len()<=MAX_TEXT && content.contains("truncated") && !content.contains("PRIVATE"))
        );
        assert!(
            state
                .normalize(&json!({"status":"invalid"}), "b".into(), false)
                .is_err()
        );
    }
}
