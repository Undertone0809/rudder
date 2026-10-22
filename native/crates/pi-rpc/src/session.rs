use crate::strict_json::StrictValue;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const MAX_SESSION_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SESSION_LINE_BYTES: usize = 1024 * 1024;
const MAX_SESSION_ENTRIES: usize = 100_000;
const MAX_MESSAGE_TEXT_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PiSessionTreeError {
    #[error("Pi session path is outside the managed session directory")]
    InvalidPath,
    #[error("Pi session file is unavailable or too large")]
    Unavailable,
    #[error("Pi session tree is malformed or ambiguous")]
    InvalidTree,
    #[error("Pi session contains valid content this adapter cannot project")]
    UnsupportedContent,
    #[error("Pi session tree exceeded its bounded size")]
    LimitExceeded,
}

pub struct PiSessionView {
    pub session_id: String,
    pub session_file: PathBuf,
    pub cwd: PathBuf,
    pub version: u64,
    pub leaf_id: Option<String>,
}

pub struct PiSessionEntry {
    id: String,
    parent_id: Option<String>,
    kind: String,
    role: Option<String>,
    text: Option<String>,
    has_image: bool,
    has_thinking: bool,
    has_tool_call: bool,
    stop_reason: Option<String>,
}

impl PiSessionEntry {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn parent_id(&self) -> Option<&str> {
        self.parent_id.as_deref()
    }
    pub fn role(&self) -> Option<&str> {
        self.role.as_deref()
    }
    pub fn kind(&self) -> &str {
        &self.kind
    }
    pub fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }

    /// A text projection cannot represent these native details completely.
    pub fn has_unprojected_content(&self) -> bool {
        !self.is_message()
            || self.has_image
            || self.has_thinking
            || self.has_tool_call
            || self.role() == Some("toolResult")
    }

    /// Safe public-text projection. Thinking blocks stay private, while images
    /// and tool calls require richer output handling than this adapter has.
    pub(crate) fn final_text(&self) -> Result<&str, PiSessionTreeError> {
        if self.has_image || self.has_tool_call {
            return Err(PiSessionTreeError::UnsupportedContent);
        }
        self.text
            .as_deref()
            .ok_or(PiSessionTreeError::UnsupportedContent)
    }

    pub fn is_message(&self) -> bool {
        self.kind == "message"
    }

    fn is_setup_metadata(&self) -> bool {
        matches!(self.kind.as_str(), "model_change" | "thinking_level_change")
    }

    pub(crate) fn stop_reason(&self) -> Option<&str> {
        self.stop_reason.as_deref()
    }
}

pub struct PiSessionTree {
    view: PiSessionView,
    entries: Vec<PiSessionEntry>,
    by_id: BTreeMap<String, usize>,
}

impl PiSessionTree {
    pub fn read(path: &Path, managed_session_dir: &Path) -> Result<Self, PiSessionTreeError> {
        let root = managed_session_dir
            .canonicalize()
            .map_err(|_| PiSessionTreeError::InvalidPath)?;
        let metadata = fs::symlink_metadata(path).map_err(|_| PiSessionTreeError::Unavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(PiSessionTreeError::InvalidPath);
        }
        if metadata.len() > MAX_SESSION_FILE_BYTES {
            return Err(PiSessionTreeError::LimitExceeded);
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| PiSessionTreeError::Unavailable)?;
        if !canonical.starts_with(&root) || canonical.parent() != Some(root.as_path()) {
            return Err(PiSessionTreeError::InvalidPath);
        }
        let bytes = fs::read(&canonical).map_err(|_| PiSessionTreeError::Unavailable)?;
        if bytes.len() as u64 > MAX_SESSION_FILE_BYTES {
            return Err(PiSessionTreeError::LimitExceeded);
        }
        let mut lines = bytes.split(|byte| *byte == b'\n');
        let header = lines.next().ok_or(PiSessionTreeError::InvalidTree)?;
        if header.is_empty() || header.len() > MAX_SESSION_LINE_BYTES {
            return Err(PiSessionTreeError::InvalidTree);
        }
        let StrictValue(header) =
            serde_json::from_slice(header).map_err(|_| PiSessionTreeError::InvalidTree)?;
        let header = header.as_object().ok_or(PiSessionTreeError::InvalidTree)?;
        if header.get("type").and_then(Value::as_str) != Some("session") {
            return Err(PiSessionTreeError::InvalidTree);
        }
        let version = header
            .get("version")
            .and_then(Value::as_u64)
            .filter(|version| (1..=3).contains(version))
            .ok_or(PiSessionTreeError::InvalidTree)?;
        let session_id = header
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_session_id(id))
            .ok_or(PiSessionTreeError::InvalidTree)?
            .to_owned();
        let cwd = header
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| Path::new(cwd).is_absolute())
            .map(PathBuf::from)
            .ok_or(PiSessionTreeError::InvalidTree)?;

        let mut entries = Vec::new();
        let mut by_id = BTreeMap::new();
        let mut ids = BTreeSet::new();
        let mut leaf_id = None;
        for line in lines {
            if line.is_empty() {
                continue;
            }
            if line.len() > MAX_SESSION_LINE_BYTES {
                return Err(PiSessionTreeError::LimitExceeded);
            }
            if entries.len() >= MAX_SESSION_ENTRIES {
                return Err(PiSessionTreeError::LimitExceeded);
            }
            let StrictValue(value) =
                serde_json::from_slice(line).map_err(|_| PiSessionTreeError::InvalidTree)?;
            let object = value.as_object().ok_or(PiSessionTreeError::InvalidTree)?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_entry_id(id))
                .ok_or(PiSessionTreeError::InvalidTree)?
                .to_owned();
            if !ids.insert(id.clone()) {
                return Err(PiSessionTreeError::InvalidTree);
            }
            let parent_id = match object.get("parentId") {
                Some(Value::Null) | None if entries.is_empty() => None,
                Some(Value::String(parent)) if by_id.contains_key(parent) => Some(parent.clone()),
                _ => return Err(PiSessionTreeError::InvalidTree),
            };
            let kind = object
                .get("type")
                .and_then(Value::as_str)
                .filter(|kind| kind.len() <= 64)
                .ok_or(PiSessionTreeError::InvalidTree)?
                .to_owned();
            let (role, content, stop_reason) = if kind == "message" {
                let message = object
                    .get("message")
                    .and_then(Value::as_object)
                    .ok_or(PiSessionTreeError::InvalidTree)?;
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .filter(|role| matches!(*role, "user" | "assistant" | "toolResult"))
                    .ok_or(PiSessionTreeError::InvalidTree)?
                    .to_owned();
                let content = message_content(message.get("content"))?;
                let stop_reason = match message.get("stopReason") {
                    Some(Value::String(value)) if value.len() <= 32 => Some(value.clone()),
                    Some(Value::String(_)) => return Err(PiSessionTreeError::InvalidTree),
                    Some(Value::Null) | None => None,
                    _ => return Err(PiSessionTreeError::InvalidTree),
                };
                (Some(role), Some(content), stop_reason)
            } else {
                (None, None, None)
            };
            let index = entries.len();
            by_id.insert(id.clone(), index);
            leaf_id = Some(id.clone());
            entries.push(PiSessionEntry {
                id,
                parent_id,
                kind,
                role,
                text: content.as_ref().map(|content| content.text.clone()),
                has_image: content.as_ref().is_some_and(|content| content.has_image),
                has_thinking: content.as_ref().is_some_and(|content| content.has_thinking),
                has_tool_call: content
                    .as_ref()
                    .is_some_and(|content| content.has_tool_call),
                stop_reason,
            });
        }
        Ok(Self {
            view: PiSessionView {
                session_id,
                session_file: canonical,
                cwd,
                version,
                leaf_id,
            },
            entries,
            by_id,
        })
    }

    pub fn view(&self) -> &PiSessionView {
        &self.view
    }

    pub fn entries(&self) -> &[PiSessionEntry] {
        &self.entries
    }

    pub fn entry(&self, id: &str) -> Option<&PiSessionEntry> {
        self.by_id
            .get(id)
            .and_then(|index| self.entries.get(*index))
    }

    /// Check that the active native leaf has not advanced beyond the
    /// checkpoint except for Pi's model/thinking setup metadata. The suffix
    /// must be one linear chain from the trusted anchor; a user turn, tool
    /// result, unknown record, or branch means the resumed prompt would attach
    /// to uncheckpointed native state.
    pub fn active_leaf_continues_with_setup_metadata(&self, anchor_id: Option<&str>) -> bool {
        let (suffix_start, mut expected_parent) = match anchor_id {
            Some(anchor_id) => {
                let Some(index) = self.by_id.get(anchor_id).copied() else {
                    return false;
                };
                (index + 1, Some(anchor_id))
            }
            None => (0, None),
        };

        for entry in self.entries.iter().skip(suffix_start) {
            if !entry.is_setup_metadata() || entry.parent_id() != expected_parent {
                return false;
            }
            expected_parent = Some(entry.id());
        }

        self.view.leaf_id.as_deref() == expected_parent
    }

    /// Resolve a persisted Run range at its own sealed leaf, independently of
    /// the file's current leaf or subsequently appended turns and branches.
    /// Authorization and the persisted selector belong to the caller. This
    /// returns typed entries, not a claim of complete text projection.
    pub fn read_span(
        &self,
        input_id: &str,
        assistant_id: &str,
        sealed_leaf_id: &str,
    ) -> Result<Vec<&PiSessionEntry>, PiSessionTreeError> {
        let input = self
            .entry(input_id)
            .ok_or(PiSessionTreeError::InvalidTree)?;
        let assistant = self
            .entry(assistant_id)
            .ok_or(PiSessionTreeError::InvalidTree)?;
        if input.role() != Some("user")
            || assistant.role() != Some("assistant")
            || !self.is_ancestor(input_id, assistant_id)
            || !self.is_ancestor(assistant_id, sealed_leaf_id)
        {
            return Err(PiSessionTreeError::InvalidTree);
        }
        let mut entries = Vec::new();
        let mut cursor = Some(sealed_leaf_id);
        while let Some(id) = cursor {
            let entry = self.entry(id).ok_or(PiSessionTreeError::InvalidTree)?;
            if entries.len() >= self.entries.len()
                || (entry.role() == Some("user") && entry.id() != input_id)
            {
                return Err(PiSessionTreeError::InvalidTree);
            }
            entries.push(entry);
            if entry.id() == input_id {
                entries.reverse();
                return Ok(entries);
            }
            cursor = entry.parent_id();
        }
        Err(PiSessionTreeError::InvalidTree)
    }

    pub fn is_ancestor(&self, ancestor_id: &str, descendant_id: &str) -> bool {
        let mut current = Some(descendant_id);
        let mut visited = 0usize;
        while let Some(id) = current {
            if id == ancestor_id {
                return true;
            }
            visited += 1;
            if visited > self.entries.len() {
                return false;
            }
            current = self.entry(id).and_then(PiSessionEntry::parent_id);
        }
        false
    }

    pub fn exact_user_child(&self, parent_id: Option<&str>, body: &str) -> Option<&PiSessionEntry> {
        let mut matches = self.entries.iter().filter(|entry| {
            entry.is_message()
                && entry.role() == Some("user")
                && !entry.has_image
                && !entry.has_thinking
                && !entry.has_tool_call
                && entry.parent_id() == parent_id
                && entry.text() == Some(body)
        });
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    }

    fn exact_user_after_setup_metadata(
        &self,
        parent_id: Option<&str>,
        body: &str,
    ) -> Option<&PiSessionEntry> {
        if parent_id.is_some_and(|id| self.entry(id).is_none()) {
            return None;
        }
        let mut setup_ancestors = BTreeSet::new();
        if let Some(parent_id) = parent_id {
            setup_ancestors.insert(parent_id.to_owned());
        }
        let mut matched = None;
        for entry in &self.entries {
            let parent_is_anchored = match entry.parent_id() {
                Some(parent_id) => setup_ancestors.contains(parent_id),
                None => parent_id.is_none(),
            };
            if !parent_is_anchored {
                continue;
            }
            if entry.is_message()
                && entry.role() == Some("user")
                && !entry.has_image
                && !entry.has_thinking
                && !entry.has_tool_call
                && entry.text() == Some(body)
            {
                if matched.is_some() {
                    return None;
                }
                matched = Some(entry);
            } else if entry.is_setup_metadata() {
                setup_ancestors.insert(entry.id.clone());
            }
        }
        matched
    }

    /// Resolve one exact user input and its terminal assistant message from
    /// this session's persisted tree. The input may follow only the provider's
    /// model/thinking setup metadata after the prior leaf. The latest assistant
    /// message must be a descendant of the unique input and an ancestor of the
    /// current leaf.
    pub(crate) fn exact_completed_turn(
        &self,
        parent_id: Option<&str>,
        body: &str,
    ) -> Option<(&PiSessionEntry, &PiSessionEntry)> {
        let input = self.exact_user_after_setup_metadata(parent_id, body)?;
        let leaf_id = self.view.leaf_id.as_deref()?;
        let mut assistant = None;
        for entry in &self.entries {
            if entry.is_message()
                && entry.role() == Some("user")
                && entry.id() != input.id()
                && self.is_ancestor(input.id(), entry.id())
            {
                // More than one user turn below the submitted input makes the
                // observed turn ambiguous; never select a later user message.
                return None;
            }
            if entry.is_message()
                && entry.role() == Some("assistant")
                && self.is_ancestor(input.id(), entry.id())
                && self.is_ancestor(entry.id(), leaf_id)
            {
                assistant = Some(entry);
            }
        }
        Some((input, assistant?))
    }

    pub(crate) fn has_tool_content_between(
        &self,
        input: &PiSessionEntry,
        terminal: &PiSessionEntry,
    ) -> bool {
        self.entries.iter().any(|entry| {
            (entry.has_tool_call || entry.role() == Some("toolResult"))
                && self.is_ancestor(input.id(), entry.id())
                && self.is_ancestor(entry.id(), terminal.id())
        })
    }
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn valid_entry_id(value: &str) -> bool {
    value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

struct MessageContent {
    text: String,
    has_image: bool,
    has_thinking: bool,
    has_tool_call: bool,
}

fn message_content(content: Option<&Value>) -> Result<MessageContent, PiSessionTreeError> {
    let content = content.ok_or(PiSessionTreeError::InvalidTree)?;
    let mut result = MessageContent {
        text: String::new(),
        has_image: false,
        has_thinking: false,
        has_tool_call: false,
    };
    match content {
        Value::String(text) => result.text.push_str(text),
        Value::Array(blocks) => {
            for block in blocks {
                let Some(object) = block.as_object() else {
                    return Err(PiSessionTreeError::InvalidTree);
                };
                match object.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = object
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or(PiSessionTreeError::InvalidTree)?;
                        if result.text.len().saturating_add(text.len()) > MAX_MESSAGE_TEXT_BYTES {
                            return Err(PiSessionTreeError::LimitExceeded);
                        }
                        result.text.push_str(text);
                    }
                    Some("thinking") => {
                        let thinking = object
                            .get("thinking")
                            .and_then(Value::as_str)
                            .ok_or(PiSessionTreeError::InvalidTree)?;
                        if thinking.len() > MAX_MESSAGE_TEXT_BYTES {
                            return Err(PiSessionTreeError::LimitExceeded);
                        }
                        result.has_thinking = true;
                    }
                    Some("image") => {
                        let data = object.get("data").and_then(Value::as_str);
                        let mime_type = object.get("mimeType").and_then(Value::as_str);
                        if data.is_none_or(|value| value.len() > MAX_MESSAGE_TEXT_BYTES)
                            || !mime_type
                                .is_some_and(|value| !value.is_empty() && value.len() <= 128)
                        {
                            return Err(PiSessionTreeError::InvalidTree);
                        }
                        result.has_image = true;
                    }
                    Some("toolCall") => {
                        if !object
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.is_empty() && value.len() <= 256)
                            || !object
                                .get("name")
                                .and_then(Value::as_str)
                                .is_some_and(|value| !value.is_empty() && value.len() <= 256)
                            || !object.get("arguments").is_some_and(Value::is_object)
                        {
                            return Err(PiSessionTreeError::InvalidTree);
                        }
                        result.has_tool_call = true;
                    }
                    _ => return Err(PiSessionTreeError::UnsupportedContent),
                }
            }
        }
        _ => return Err(PiSessionTreeError::InvalidTree),
    }
    if result.text.len() > MAX_MESSAGE_TEXT_BYTES {
        return Err(PiSessionTreeError::LimitExceeded);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{PiSessionTree, PiSessionTreeError};
    use std::fs;

    fn fixture_session_header() -> String {
        serde_json::json!({
            "type": "session",
            "version": 3,
            "id": "session-uuid",
            "cwd": std::env::current_dir()
                .expect("test working directory")
                .to_string_lossy()
                .into_owned(),
        })
        .to_string()
    }

    fn session(lines: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi-session.jsonl");
        let mut content = fixture_session_header();
        content.push('\n');
        for line in lines {
            content.push_str(line);
            content.push('\n');
        }
        fs::write(&path, content).unwrap();
        (dir, path)
    }

    #[test]
    fn exact_session_reader_validates_tree_and_selects_unique_user_child() {
        let (dir, path) = session(&[
            r#"{"type":"model_change","id":"aaaaaaaa","parentId":null,"provider":"p","modelId":"m"}"#,
            r#"{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","message":{"role":"user","content":"exact input 雪"}}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        assert_eq!(tree.view().session_id, "session-uuid");
        assert_eq!(tree.view().leaf_id.as_deref(), Some("cccccccc"));
        assert_eq!(
            tree.exact_user_child(Some("aaaaaaaa"), "exact input 雪")
                .unwrap()
                .id(),
            "bbbbbbbb"
        );
        assert!(tree.is_ancestor("bbbbbbbb", "cccccccc"));
        assert!(tree.exact_user_child(Some("aaaaaaaa"), "other").is_none());
    }

    #[test]
    fn completed_turn_follows_pi_setup_metadata_before_the_exact_input() {
        let (dir, path) = session(&[
            r#"{"type":"model_change","id":"964a1d3c","parentId":null,"provider":"p","modelId":"m"}"#,
            r#"{"type":"thinking_level_change","id":"a11d32cc","parentId":"964a1d3c","thinkingLevel":"medium"}"#,
            r#"{"type":"message","id":"2464a586","parentId":"a11d32cc","message":{"role":"user","content":"exact input 雪"}}"#,
            r#"{"type":"message","id":"52c6fa1d","parentId":"2464a586","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stopReason":"stop"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        let (input, assistant) = tree.exact_completed_turn(None, "exact input 雪").unwrap();
        assert_eq!(input.id(), "2464a586");
        assert_eq!(input.parent_id(), Some("a11d32cc"));
        assert_eq!(assistant.id(), "52c6fa1d");
        assert_eq!(assistant.parent_id(), Some(input.id()));
        assert_eq!(assistant.stop_reason(), Some("stop"));
    }

    #[test]
    fn completed_turn_follows_setup_metadata_from_the_prior_leaf() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"aaaaaaaa","parentId":null,"message":{"role":"user","content":"first"}}"#,
            r#"{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","message":{"role":"assistant","content":"first answer","stopReason":"stop"}}"#,
            r#"{"type":"model_change","id":"cccccccc","parentId":"bbbbbbbb"}"#,
            r#"{"type":"thinking_level_change","id":"dddddddd","parentId":"cccccccc"}"#,
            r#"{"type":"message","id":"eeeeeeee","parentId":"dddddddd","message":{"role":"user","content":"second"}}"#,
            r#"{"type":"message","id":"ffffffff","parentId":"eeeeeeee","message":{"role":"assistant","content":"second answer","stopReason":"stop"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        let (input, assistant) = tree
            .exact_completed_turn(Some("bbbbbbbb"), "second")
            .unwrap();
        assert_eq!(input.id(), "eeeeeeee");
        assert_eq!(assistant.id(), "ffffffff");
    }

    #[test]
    fn active_leaf_allows_only_a_linear_setup_metadata_suffix() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"aaaaaaaa","parentId":null,"message":{"role":"user","content":"first"}}"#,
            r#"{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","message":{"role":"assistant","content":"first answer","stopReason":"stop"}}"#,
            r#"{"type":"model_change","id":"cccccccc","parentId":"bbbbbbbb"}"#,
            r#"{"type":"thinking_level_change","id":"dddddddd","parentId":"cccccccc"}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        assert!(tree.active_leaf_continues_with_setup_metadata(Some("bbbbbbbb")));
        assert!(!tree.active_leaf_continues_with_setup_metadata(Some("aaaaaaaa")));
        assert!(!tree.active_leaf_continues_with_setup_metadata(None));
    }

    #[test]
    fn active_leaf_accepts_a_fresh_or_metadata_only_session() {
        let (empty_dir, empty_path) = session(&[]);
        let empty = PiSessionTree::read(&empty_path, empty_dir.path()).unwrap();
        assert!(empty.active_leaf_continues_with_setup_metadata(None));

        let (metadata_dir, metadata_path) = session(&[
            r#"{"type":"model_change","id":"aaaaaaaa","parentId":null}"#,
            r#"{"type":"thinking_level_change","id":"bbbbbbbb","parentId":"aaaaaaaa"}"#,
        ]);
        let metadata = PiSessionTree::read(&metadata_path, metadata_dir.path()).unwrap();
        assert!(metadata.active_leaf_continues_with_setup_metadata(None));
        assert!(!metadata.active_leaf_continues_with_setup_metadata(Some("cccccccc")));
    }

    #[test]
    fn active_leaf_rejects_uncheckpointed_messages_tools_unknown_records_and_branches() {
        for suffix in [
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"user","content":"external user"}}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"toolResult","content":"tool output"}}"#,
            r#"{"type":"extension_state","id":"cccccccc","parentId":"bbbbbbbb"}"#,
            r#"{"type":"model_change","id":"cccccccc","parentId":"aaaaaaaa"}"#,
        ] {
            let (dir, path) = session(&[
                r#"{"type":"message","id":"aaaaaaaa","parentId":null,"message":{"role":"user","content":"first"}}"#,
                r#"{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","message":{"role":"assistant","content":"first answer","stopReason":"stop"}}"#,
                suffix,
            ]);
            let tree = PiSessionTree::read(&path, dir.path()).unwrap();
            assert!(
                !tree.active_leaf_continues_with_setup_metadata(Some("bbbbbbbb")),
                "must reject uncheckpointed active suffix {suffix}"
            );
        }
    }

    #[test]
    fn completed_turn_rejects_duplicate_inputs_across_setup_branches() {
        let (dir, path) = session(&[
            r#"{"type":"model_change","id":"aaaaaaaa","parentId":null}"#,
            r#"{"type":"thinking_level_change","id":"bbbbbbbb","parentId":"aaaaaaaa"}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"user","content":"same input"}}"#,
            r#"{"type":"message","id":"dddddddd","parentId":"cccccccc","message":{"role":"assistant","content":"first answer","stopReason":"stop"}}"#,
            r#"{"type":"thinking_level_change","id":"eeeeeeee","parentId":"aaaaaaaa"}"#,
            r#"{"type":"message","id":"ffffffff","parentId":"eeeeeeee","message":{"role":"user","content":"same input"}}"#,
            r#"{"type":"message","id":"11111111","parentId":"ffffffff","message":{"role":"assistant","content":"second answer","stopReason":"stop"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        assert!(tree.exact_completed_turn(None, "same input").is_none());
    }

    #[test]
    fn completed_turn_rejects_unrelated_leaf_branch() {
        let (dir, path) = session(&[
            r#"{"type":"model_change","id":"aaaaaaaa","parentId":null}"#,
            r#"{"type":"thinking_level_change","id":"bbbbbbbb","parentId":"aaaaaaaa"}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"user","content":"target input"}}"#,
            r#"{"type":"message","id":"dddddddd","parentId":"cccccccc","message":{"role":"assistant","content":"target answer","stopReason":"stop"}}"#,
            r#"{"type":"thinking_level_change","id":"eeeeeeee","parentId":"aaaaaaaa"}"#,
            r#"{"type":"message","id":"ffffffff","parentId":"eeeeeeee","message":{"role":"user","content":"other input"}}"#,
            r#"{"type":"message","id":"11111111","parentId":"ffffffff","message":{"role":"assistant","content":"other answer","stopReason":"stop"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        assert!(tree.exact_completed_turn(None, "target input").is_none());
    }

    #[test]
    fn completed_turn_rejects_tool_or_unknown_nodes_before_the_input() {
        let cases = [
            [
                r#"{"type":"model_change","id":"aaaaaaaa","parentId":null}"#,
                r#"{"type":"branch_summary","id":"bbbbbbbb","parentId":"aaaaaaaa"}"#,
                r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"user","content":"x"}}"#,
                r#"{"type":"message","id":"dddddddd","parentId":"cccccccc","message":{"role":"assistant","content":"answer","stopReason":"stop"}}"#,
            ],
            [
                r#"{"type":"model_change","id":"aaaaaaaa","parentId":null}"#,
                r#"{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","message":{"role":"toolResult","content":"result"}}"#,
                r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"user","content":"x"}}"#,
                r#"{"type":"message","id":"dddddddd","parentId":"cccccccc","message":{"role":"assistant","content":"answer","stopReason":"stop"}}"#,
            ],
        ];
        for lines in cases {
            let (dir, path) = session(&lines);
            let tree = PiSessionTree::read(&path, dir.path()).unwrap();
            assert!(tree.exact_completed_turn(None, "x").is_none());
        }
    }

    #[test]
    fn persisted_span_does_not_follow_later_turns_or_sibling_branches() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"aaaaaaaa","parentId":null,"message":{"role":"user","content":"first"}}"#,
            r#"{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","message":{"role":"assistant","content":"first answer"}}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"user","content":"second"}}"#,
            r#"{"type":"message","id":"dddddddd","parentId":"cccccccc","message":{"role":"assistant","content":"second answer"}}"#,
            r#"{"type":"message","id":"eeeeeeee","parentId":"aaaaaaaa","message":{"role":"assistant","content":"sibling answer"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        assert_eq!(tree.view().leaf_id.as_deref(), Some("eeeeeeee"));
        let old = tree.read_span("aaaaaaaa", "bbbbbbbb", "bbbbbbbb").unwrap();
        assert_eq!(
            old.iter().map(|entry| entry.id()).collect::<Vec<_>>(),
            ["aaaaaaaa", "bbbbbbbb"]
        );
        assert_eq!(old[1].text(), Some("first answer"));
        let second = tree.read_span("cccccccc", "dddddddd", "dddddddd").unwrap();
        assert_eq!(second[1].text(), Some("second answer"));
        for (input, assistant, leaf) in [
            ("aaaaaaaa", "bbbbbbbb", "eeeeeeee"),
            ("aaaaaaaa", "bbbbbbbb", "dddddddd"),
            ("aaaaaaaa", "dddddddd", "dddddddd"),
            ("cccccccc", "eeeeeeee", "eeeeeeee"),
            ("aaaaaaaa", "bbbbbbbb", "ffffffff"),
            ("bbbbbbbb", "bbbbbbbb", "bbbbbbbb"),
        ] {
            assert!(tree.read_span(input, assistant, leaf).is_err());
        }
    }

    #[test]
    fn exact_session_reader_rejects_duplicate_ids_or_non_tree_parent() {
        for lines in [
            vec![
                r#"{"type":"message","id":"aaaaaaaa","parentId":null,"message":{"role":"user","content":"x"}}"#,
                r#"{"type":"message","id":"aaaaaaaa","parentId":null,"message":{"role":"user","content":"x"}}"#,
            ],
            vec![
                r#"{"type":"message","id":"bbbbbbbb","parentId":"aaaaaaaa","message":{"role":"user","content":"x"}}"#,
            ],
        ] {
            let (dir, path) = session(&lines);
            assert_eq!(
                PiSessionTree::read(&path, dir.path()).err(),
                Some(PiSessionTreeError::InvalidTree)
            );
        }
    }

    #[test]
    fn assistant_text_plus_unknown_block_is_unsupported_not_completed() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"bbbbbbbb","parentId":null,"message":{"role":"user","content":"x"}}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"assistant","content":[{"type":"text","text":"visible"},{"type":"future_audio","data":"hidden"}],"stopReason":"stop"}}"#,
        ]);
        assert_eq!(
            PiSessionTree::read(&path, dir.path()).err(),
            Some(PiSessionTreeError::UnsupportedContent)
        );
    }

    #[test]
    fn assistant_text_plus_image_is_known_but_not_text_projectable() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"bbbbbbbb","parentId":null,"message":{"role":"user","content":"x"}}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"assistant","content":[{"type":"text","text":"visible"},{"type":"image","data":"AQID","mimeType":"image/png"}],"stopReason":"stop"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        let assistant = tree.entry("cccccccc").unwrap();
        assert!(assistant.has_image);
        assert_eq!(
            assistant.final_text(),
            Err(PiSessionTreeError::UnsupportedContent)
        );
    }

    #[test]
    fn assistant_thinking_is_recognized_and_never_added_to_public_text() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"bbbbbbbb","parentId":null,"message":{"role":"user","content":"x"}}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private reasoning"},{"type":"text","text":"public answer"}],"stopReason":"stop"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        let assistant = tree.entry("cccccccc").unwrap();
        assert!(assistant.has_thinking);
        assert!(assistant.has_unprojected_content());
        assert_eq!(assistant.final_text().unwrap(), "public answer");
        assert!(
            !assistant
                .final_text()
                .unwrap()
                .contains("private reasoning")
        );
    }

    #[test]
    fn tool_call_and_tool_result_remain_typed_and_tool_use_is_not_final_text() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"bbbbbbbb","parentId":null,"message":{"role":"user","content":"x"}}"#,
            r#"{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","message":{"role":"assistant","content":[{"type":"text","text":"before"},{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"x"}}],"stopReason":"toolUse"}}"#,
            r#"{"type":"message","id":"dddddddd","parentId":"cccccccc","message":{"role":"toolResult","toolCallId":"call-1","content":[{"type":"text","text":"result"}],"isError":false}}"#,
            r#"{"type":"message","id":"eeeeeeee","parentId":"dddddddd","message":{"role":"assistant","content":[{"type":"text","text":"after"}],"stopReason":"stop"}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        let tool_call = tree.entry("cccccccc").unwrap();
        assert!(tool_call.has_tool_call);
        assert_eq!(
            tool_call.final_text(),
            Err(PiSessionTreeError::UnsupportedContent)
        );
        assert_eq!(tree.entry("dddddddd").unwrap().role(), Some("toolResult"));
        assert_eq!(
            tree.entry("eeeeeeee").unwrap().final_text().unwrap(),
            "after"
        );
        let (input, terminal) = tree.exact_completed_turn(None, "x").unwrap();
        assert!(tree.has_tool_content_between(input, terminal));
    }

    #[test]
    fn user_attachment_cannot_match_a_plain_text_submission() {
        let (dir, path) = session(&[
            r#"{"type":"message","id":"bbbbbbbb","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"x"},{"type":"image","data":"AQID","mimeType":"image/png"}]}}"#,
        ]);
        let tree = PiSessionTree::read(&path, dir.path()).unwrap();
        assert!(tree.exact_user_child(None, "x").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn exact_session_reader_rejects_symlinked_session_files() {
        use std::os::unix::fs::symlink;
        let (dir, path) = session(&[]);
        let target = dir.path().join("link.jsonl");
        symlink(&path, &target).unwrap();
        assert_eq!(
            PiSessionTree::read(&target, dir.path()).err(),
            Some(PiSessionTreeError::InvalidPath)
        );
    }
}
