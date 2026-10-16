//! Opaque, connection-bound evidence produced only by `OwnedTransport`.

use crate::TransportError;
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_EARLY_EVENTS: usize = 32;
const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_EARLY_BYTES: usize = 1024 * 1024;
const MAX_FINAL_TEXT_BYTES: usize = 256 * 1024;
const MAX_TOKEN_COUNT: u64 = 1_000_000_000_000;
const MAX_FINAL_ITEMS: usize = 32;
const MAX_ACTIVE_EVENTS: usize = 128;
static NEXT_CONNECTION_RECEIPT_ID: AtomicU64 = AtomicU64::new(1);

pub struct CleanupReceipt {
    identity: ReceiptIdentity,
}

impl CleanupReceipt {
    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.identity.matches(run_id, attempt_id, owner_token)
    }

    pub fn proves_quiescence_for(&self, turn: &TurnReceipt) -> bool {
        self.identity.connection_receipt_id == turn.identity.connection_receipt_id
            && self.identity.matches_identity(&turn.identity)
    }

    pub fn connection_receipt_id(&self) -> &str {
        &self.identity.connection_receipt_id
    }

    pub fn evidence_fingerprint(&self) -> String {
        format!(
            "codex-owned-cleanup-v1:{}",
            self.identity.connection_receipt_id
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnStatus {
    Completed,
    Failed,
    Interrupted,
}

/// The latest correlated `tokenUsage.last` observation for this provider turn.
/// Codex reports a last-model-response increment, not an aggregate user-turn
/// total; consumers must not sum repeated updates or present this as Run usage.
pub struct TurnUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
}

impl TurnUsage {
    pub fn input_tokens(&self) -> u64 {
        self.input_tokens
    }
    pub fn cached_input_tokens(&self) -> u64 {
        self.cached_input_tokens
    }
    pub fn output_tokens(&self) -> u64 {
        self.output_tokens
    }
    pub fn reasoning_output_tokens(&self) -> u64 {
        self.reasoning_output_tokens
    }
    pub fn total_tokens(&self) -> u64 {
        self.total_tokens
    }
}

pub struct TurnReceipt {
    identity: ReceiptIdentity,
    thread_id: String,
    turn_id: String,
    status: TurnStatus,
    final_text: Option<String>,
    usage: Option<TurnUsage>,
}

impl TurnReceipt {
    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }
    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }
    pub fn status(&self) -> TurnStatus {
        self.status
    }
    pub fn final_text(&self) -> Option<&str> {
        self.final_text.as_deref()
    }
    pub fn usage(&self) -> Option<&TurnUsage> {
        self.usage.as_ref()
    }
    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.identity.matches(run_id, attempt_id, owner_token)
    }
}

pub(crate) struct ReceiptIdentity {
    run_id: String,
    attempt_id: String,
    owner_token: String,
    connection_receipt_id: String,
}

impl ReceiptIdentity {
    pub(crate) fn new(run_id: String, attempt_id: String, owner_token: String) -> Self {
        let counter = NEXT_CONNECTION_RECEIPT_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            run_id,
            attempt_id,
            owner_token,
            connection_receipt_id: format!("{}-{counter}", std::process::id()),
        }
    }

    fn clone_for_receipt(&self) -> Self {
        Self {
            run_id: self.run_id.clone(),
            attempt_id: self.attempt_id.clone(),
            owner_token: self.owner_token.clone(),
            connection_receipt_id: self.connection_receipt_id.clone(),
        }
    }

    fn matches_identity(&self, other: &Self) -> bool {
        self.run_id == other.run_id
            && self.attempt_id == other.attempt_id
            && self.owner_token == other.owner_token
    }

    fn matches(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.run_id == run_id && self.attempt_id == attempt_id && self.owner_token == owner_token
    }

    pub(crate) fn cleanup_receipt(&self) -> CleanupReceipt {
        CleanupReceipt {
            identity: self.clone_for_receipt(),
        }
    }
}

pub(crate) struct TurnReceiptTracker {
    identity: ReceiptIdentity,
    capture_armed: bool,
    early: VecDeque<(String, Value)>,
    early_bytes: usize,
    active: Option<ActiveTurn>,
    receipt: Option<TurnReceipt>,
}

struct ActiveTurn {
    thread_id: String,
    turn_id: String,
    items: BTreeMap<String, String>,
    usage: Option<TurnUsage>,
    terminal: Option<(TurnStatus, Option<BTreeMap<String, String>>)>,
    observed_events: usize,
}

impl TurnReceiptTracker {
    pub(crate) fn new(identity: ReceiptIdentity) -> Self {
        Self {
            identity,
            capture_armed: false,
            early: VecDeque::new(),
            early_bytes: 0,
            active: None,
            receipt: None,
        }
    }

    pub(crate) fn observe(&mut self, method: &str, params: Value) -> Result<(), TransportError> {
        if !matches!(
            method,
            "item/completed" | "thread/tokenUsage/updated" | "turn/completed"
        ) {
            return Ok(());
        }
        let before_turn_dispatch = !self.capture_armed && self.active.is_none();
        let after_terminal = self
            .active
            .as_ref()
            .is_some_and(|active| active.terminal.is_some());
        if before_turn_dispatch || after_terminal {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&params)
            .map_err(|_| TransportError::InvalidTurnReceipt)?
            .len();
        if bytes > MAX_EVENT_BYTES {
            return Err(TransportError::InvalidTurnReceipt);
        }
        if let Some(active) = self.active.as_mut() {
            return active.observe(method, params);
        }
        if !self.capture_armed {
            return Ok(());
        }
        if self.early.len() >= MAX_EARLY_EVENTS
            || self.early_bytes.saturating_add(bytes) > MAX_EARLY_BYTES
        {
            return Err(TransportError::InvalidTurnReceipt);
        }
        self.early_bytes += bytes;
        self.early.push_back((method.to_owned(), params));
        Ok(())
    }

    pub(crate) fn arm(&mut self) -> Result<(), TransportError> {
        if self.capture_armed || self.active.is_some() || self.receipt.is_some() {
            return Err(TransportError::InvalidTurnReceipt);
        }
        self.early.clear();
        self.early_bytes = 0;
        self.capture_armed = true;
        Ok(())
    }

    pub(crate) fn begin_turn(
        &mut self,
        thread_id: String,
        turn_id: String,
    ) -> Result<(), TransportError> {
        if !self.capture_armed
            || self.active.is_some()
            || self.receipt.is_some()
            || thread_id.is_empty()
            || turn_id.is_empty()
        {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let mut active = ActiveTurn {
            thread_id,
            turn_id,
            items: BTreeMap::new(),
            usage: None,
            terminal: None,
            observed_events: 0,
        };
        for (method, params) in std::mem::take(&mut self.early) {
            active.observe(&method, params)?;
        }
        self.early_bytes = 0;
        self.capture_armed = false;
        self.active = Some(active);
        Ok(())
    }

    pub(crate) fn is_armed(&self) -> bool {
        self.active.is_some()
    }

    pub(crate) fn has_terminal(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.terminal.is_some())
    }

    pub(crate) fn cleanup_receipt(&self) -> CleanupReceipt {
        self.identity.cleanup_receipt()
    }

    pub(crate) fn finish(&mut self) -> Result<(), TransportError> {
        if self.receipt.is_some() {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let active = self
            .active
            .take()
            .ok_or(TransportError::InvalidTurnReceipt)?;
        let (status, terminal_items) = active.terminal.ok_or(TransportError::InvalidTurnReceipt)?;
        let final_items = match terminal_items {
            Some(terminal_items) => {
                if !active.items.is_empty() && terminal_items != active.items {
                    return Err(TransportError::InvalidTurnReceipt);
                }
                terminal_items
            }
            _ => active.items,
        };
        if final_items.len() > 1 {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let final_text = final_items.into_values().next();
        self.receipt = Some(TurnReceipt {
            identity: self.identity.clone_for_receipt(),
            thread_id: active.thread_id,
            turn_id: active.turn_id,
            status,
            final_text,
            usage: active.usage,
        });
        Ok(())
    }

    pub(crate) fn take(&mut self) -> Option<TurnReceipt> {
        self.receipt.take()
    }
}

impl ActiveTurn {
    fn observe(&mut self, method: &str, params: Value) -> Result<(), TransportError> {
        if self.terminal.is_some() {
            return Ok(());
        }
        self.observed_events = self
            .observed_events
            .checked_add(1)
            .filter(|count| *count <= MAX_ACTIVE_EVENTS)
            .ok_or(TransportError::InvalidTurnReceipt)?;
        match method {
            "item/completed" => self.observe_item(&params),
            "thread/tokenUsage/updated" => self.observe_usage(&params),
            "turn/completed" => self.observe_terminal(&params),
            _ => Ok(()),
        }
    }

    fn observe_item(&mut self, params: &Value) -> Result<(), TransportError> {
        if exact_locator(&params["threadId"]) != Some(self.thread_id.as_str())
            || exact_locator(&params["turnId"]) != Some(self.turn_id.as_str())
        {
            return Ok(());
        }
        let item = &params["item"];
        if item["type"] != "agentMessage" || item["phase"] != "final_answer" {
            return Ok(());
        }
        let id = required_locator(&item["id"])?;
        let text = item["text"]
            .as_str()
            .filter(|text| text.len() <= MAX_FINAL_TEXT_BYTES)
            .ok_or(TransportError::InvalidTurnReceipt)?
            .to_owned();
        insert_item(&mut self.items, id, text)
    }

    fn observe_usage(&mut self, params: &Value) -> Result<(), TransportError> {
        if exact_locator(&params["threadId"]) != Some(self.thread_id.as_str())
            || exact_locator(&params["turnId"]) != Some(self.turn_id.as_str())
        {
            return Ok(());
        }
        let last = &params["tokenUsage"]["last"];
        let usage = TurnUsage {
            total_tokens: token_count(&last["totalTokens"])?,
            input_tokens: token_count(&last["inputTokens"])?,
            cached_input_tokens: token_count(&last["cachedInputTokens"])?,
            output_tokens: token_count(&last["outputTokens"])?,
            reasoning_output_tokens: token_count(&last["reasoningOutputTokens"])?,
        };
        // Updates replace the latest observed model-response increment. They
        // are snapshots, not deltas to add together.
        self.usage = Some(usage);
        Ok(())
    }

    fn observe_terminal(&mut self, params: &Value) -> Result<(), TransportError> {
        if exact_locator(&params["threadId"]) != Some(self.thread_id.as_str())
            || exact_locator(&params["turn"]["id"]) != Some(self.turn_id.as_str())
        {
            return Ok(());
        }
        let status = match params["turn"]["status"].as_str() {
            Some("completed") => TurnStatus::Completed,
            Some("failed") => TurnStatus::Failed,
            Some("interrupted") => TurnStatus::Interrupted,
            _ => return Err(TransportError::InvalidTurnReceipt),
        };
        let items_view = params["turn"]["itemsView"].as_str().unwrap_or("full");
        let terminal_items = match items_view {
            "full" => {
                let items = params["turn"]["items"]
                    .as_array()
                    .ok_or(TransportError::InvalidTurnReceipt)?;
                let mut final_items = BTreeMap::new();
                for item in items {
                    if item["type"] == "agentMessage" && item["phase"] == "final_answer" {
                        let id = required_locator(&item["id"])?;
                        let text = item["text"]
                            .as_str()
                            .filter(|text| text.len() <= MAX_FINAL_TEXT_BYTES)
                            .ok_or(TransportError::InvalidTurnReceipt)?
                            .to_owned();
                        insert_item(&mut final_items, id, text)?;
                    }
                }
                Some(final_items)
            }
            "summary" | "notLoaded" => None,
            _ => return Err(TransportError::InvalidTurnReceipt),
        };
        self.terminal = Some((status, terminal_items));
        Ok(())
    }
}

fn exact_locator(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 4096)
}

fn required_locator(value: &Value) -> Result<String, TransportError> {
    exact_locator(value)
        .map(str::to_owned)
        .ok_or(TransportError::InvalidTurnReceipt)
}

fn token_count(value: &Value) -> Result<u64, TransportError> {
    let count = value.as_u64().ok_or(TransportError::InvalidTurnReceipt)?;
    if count > MAX_TOKEN_COUNT {
        return Err(TransportError::InvalidTurnReceipt);
    }
    Ok(count)
}

fn insert_item(
    items: &mut BTreeMap<String, String>,
    id: String,
    text: String,
) -> Result<(), TransportError> {
    if let Some(existing) = items.get(&id) {
        if existing != &text {
            return Err(TransportError::InvalidTurnReceipt);
        }
    } else {
        if items.len() >= MAX_FINAL_ITEMS {
            return Err(TransportError::InvalidTurnReceipt);
        }
        items.insert(id, text);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tracker() -> TurnReceiptTracker {
        let mut tracker = TurnReceiptTracker::new(ReceiptIdentity::new(
            "run-1".into(),
            "attempt-1".into(),
            "secret-owner-token".into(),
        ));
        tracker.arm().unwrap();
        tracker
    }

    fn usage(thread: &str, turn: &str) -> Value {
        json!({"threadId":thread,"turnId":turn,"tokenUsage":{"last":{
            "totalTokens":12,"inputTokens":5,"cachedInputTokens":2,
            "outputTokens":7,"reasoningOutputTokens":3
        }}})
    }

    fn terminal(thread: &str, turn: &str) -> Value {
        json!({"threadId":thread,"turn":{"id":turn,"status":"completed","itemsView":"full","items":[]}})
    }

    fn item(thread: &str, turn: &str, phase: &str, text: &str) -> Value {
        json!({"threadId":thread,"turnId":turn,"item":{
            "id":"item-1","type":"agentMessage","phase":phase,"text":text
        }})
    }

    #[test]
    fn canonical_usage_without_cache_write_input_tokens_is_accepted() {
        let mut tracker = tracker();
        tracker
            .observe(
                "item/completed",
                item("thread-1", "turn-1", "final_answer", "hello 🧭"),
            )
            .unwrap();
        tracker
            .observe("thread/tokenUsage/updated", usage("thread-1", "turn-1"))
            .unwrap();
        tracker
            .observe(
                "turn/completed",
                json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[{"id":"item-1","type":"agentMessage","phase":"final_answer","text":"hello 🧭"}]}}),
            )
            .unwrap();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker.finish().unwrap();
        let receipt = tracker.take().unwrap();
        assert_eq!(receipt.thread_id(), "thread-1");
        assert_eq!(receipt.turn_id(), "turn-1");
        assert_eq!(receipt.status(), TurnStatus::Completed);
        assert_eq!(receipt.final_text(), Some("hello 🧭"));
        let usage = receipt.usage().unwrap();
        assert_eq!(usage.input_tokens(), 5);
        assert_eq!(usage.cached_input_tokens(), 2);
        assert_eq!(usage.output_tokens(), 7);
        assert_eq!(usage.reasoning_output_tokens(), 3);
        assert_eq!(usage.total_tokens(), 12);
        assert!(receipt.matches_execution("run-1", "attempt-1", "secret-owner-token"));
        assert!(!receipt.matches_execution("run-1", "attempt-2", "secret-owner-token"));
        assert!(!receipt.matches_execution("run-1", "attempt-1", "wrong-token"));
    }

    #[test]
    fn repeated_usage_updates_keep_only_the_latest_response_increment() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "thread/tokenUsage/updated",
                json!({"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{
                    "totalTokens":8,"inputTokens":5,"cachedInputTokens":1,
                    "outputTokens":3,"reasoningOutputTokens":1
                }}}),
            )
            .unwrap();
        let latest = json!({"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{
            "totalTokens":15,"inputTokens":9,"cachedInputTokens":2,
            "outputTokens":6,"reasoningOutputTokens":2
        }}});
        tracker
            .observe("thread/tokenUsage/updated", latest.clone())
            .unwrap();
        tracker
            .observe("thread/tokenUsage/updated", latest)
            .unwrap();
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        tracker.finish().unwrap();
        let receipt = tracker.take().unwrap();
        let usage = receipt.usage().unwrap();
        assert_eq!(usage.total_tokens(), 15);
        assert_eq!(usage.input_tokens(), 9);
        assert_eq!(usage.output_tokens(), 6);
    }

    #[test]
    fn commentary_never_becomes_final_text_and_terminal_full_answer_is_accepted() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/completed",
                item("thread-1", "turn-1", "commentary", "thinking"),
            )
            .unwrap();
        tracker.observe("turn/completed", json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","itemsView":"full","items":[{"id":"answer-1","type":"agentMessage","phase":"final_answer","text":"answer"},{"id":"commentary-1","type":"agentMessage","phase":"commentary","text":"private thought"}]}})).unwrap();
        tracker.finish().unwrap();
        assert_eq!(tracker.take().unwrap().final_text(), Some("answer"));
    }

    #[test]
    fn omitted_items_view_defaults_to_full_and_rejects_an_empty_conflicting_snapshot() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/completed",
                item("thread-1", "turn-1", "final_answer", "streamed answer"),
            )
            .unwrap();
        tracker
            .observe(
                "turn/completed",
                json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}),
            )
            .unwrap();
        assert!(tracker.finish().is_err());
    }

    #[test]
    fn terminal_items_not_loaded_without_final_item_notification_produces_no_text() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker.observe("turn/completed", json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"interrupted","itemsView":"summary","items":[{"id":"summary","type":"agentMessage","phase":"final_answer","text":"must ignore"}]}})).unwrap();
        tracker.finish().unwrap();
        let receipt = tracker.take().unwrap();
        assert_eq!(receipt.status(), TurnStatus::Interrupted);
        assert_eq!(receipt.final_text(), None);
        assert!(receipt.usage().is_none());
    }

    #[test]
    fn failed_or_interrupted_terminal_status_is_never_promoted_by_final_text() {
        for (wire_status, expected_status) in [
            ("failed", TurnStatus::Failed),
            ("interrupted", TurnStatus::Interrupted),
        ] {
            let mut tracker = tracker();
            tracker
                .begin_turn("thread-1".into(), "turn-1".into())
                .unwrap();
            tracker
                .observe(
                    "item/completed",
                    json!({"threadId":"thread-1","turnId":"turn-1","item":{"id":"item-1","type":"agentMessage","phase":"final_answer","text":"partial answer"}}),
                )
                .unwrap();
            tracker
                .observe(
                    "turn/completed",
                    json!({"threadId":"thread-1","turn":{"id":"turn-1","status":wire_status,"itemsView":"notLoaded"}}),
                )
                .unwrap();
            tracker.finish().unwrap();
            let receipt = tracker.take().unwrap();
            assert_eq!(receipt.status(), expected_status);
            assert_eq!(receipt.final_text(), Some("partial answer"));
        }
    }

    #[test]
    fn final_item_after_matching_terminal_cannot_change_receipt() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        tracker
            .observe(
                "item/completed",
                item("thread-1", "turn-1", "final_answer", "arrived too late"),
            )
            .unwrap();
        tracker
            .observe("thread/tokenUsage/updated", usage("thread-1", "turn-1"))
            .unwrap();
        tracker.finish().unwrap();
        let receipt = tracker.take().unwrap();
        assert_eq!(receipt.status(), TurnStatus::Completed);
        assert_eq!(receipt.final_text(), None);
        assert!(receipt.usage().is_none());
    }

    #[test]
    fn oversized_events_outside_the_receipt_window_do_not_invalidate_evidence() {
        let mut tracker = TurnReceiptTracker::new(ReceiptIdentity::new(
            "run-1".into(),
            "attempt-1".into(),
            "secret-owner-token".into(),
        ));
        let huge = json!({"threadId":"thread-1","turnId":"turn-1","item":{
            "type":"unknown","data":"x".repeat(MAX_EVENT_BYTES)
        }});
        tracker.observe("item/completed", huge.clone()).unwrap();
        tracker.arm().unwrap();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        tracker.observe("item/completed", huge).unwrap();
        tracker.finish().unwrap();
        let receipt = tracker.take().unwrap();
        assert_eq!(receipt.status(), TurnStatus::Completed);
        assert_eq!(receipt.final_text(), None);
    }

    #[test]
    fn invalid_usage_and_duplicate_final_items_fail_closed() {
        let mut malformed = tracker();
        malformed
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        let mut invalid_usage = usage("thread-1", "turn-1");
        invalid_usage["tokenUsage"]["last"]["inputTokens"] = json!(-1);
        assert!(
            malformed
                .observe("thread/tokenUsage/updated", invalid_usage)
                .is_err()
        );

        let mut duplicate = tracker();
        duplicate
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        duplicate
            .observe(
                "item/completed",
                item("thread-1", "turn-1", "final_answer", "one"),
            )
            .unwrap();
        assert!(
            duplicate
                .observe(
                    "item/completed",
                    item("thread-1", "turn-1", "final_answer", "two")
                )
                .is_err()
        );

        let mut after_terminal = tracker();
        after_terminal
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        after_terminal
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        let mut conflicting_terminal = terminal("thread-1", "turn-1");
        conflicting_terminal["turn"]["status"] = json!("failed");
        after_terminal
            .observe("turn/completed", conflicting_terminal)
            .unwrap();
        after_terminal.finish().unwrap();
        assert_eq!(
            after_terminal.take().unwrap().status(),
            TurnStatus::Completed
        );
    }

    #[test]
    fn foreign_events_are_ignored_and_event_queue_is_bounded() {
        let mut foreign = tracker();
        foreign
            .observe("turn/completed", terminal("another-thread", "turn-1"))
            .unwrap();
        foreign
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        assert!(foreign.finish().is_err());

        let mut bounded = tracker();
        let large = json!({"threadId":"thread-1","turnId":"turn-1","item":{"type":"unknown","data":"x".repeat(MAX_EVENT_BYTES)}});
        assert!(bounded.observe("item/completed", large).is_err());
    }

    #[test]
    fn cleanup_receipt_proves_only_the_turn_from_its_exact_connection() {
        let identity = ReceiptIdentity::new(
            "run-1".into(),
            "attempt-1".into(),
            "secret-owner-token".into(),
        );
        let cleanup = identity.cleanup_receipt();
        let mut tracker = TurnReceiptTracker::new(identity);
        tracker.arm().unwrap();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        tracker.finish().unwrap();
        let turn = tracker.take().unwrap();
        assert!(cleanup.proves_quiescence_for(&turn));
        assert!(!cleanup.connection_receipt_id().is_empty());
        let fingerprint = cleanup.evidence_fingerprint();
        assert!(fingerprint.starts_with("codex-owned-cleanup-v1:"));
        assert!(!fingerprint.contains("secret-owner-token"));

        let other_identity = ReceiptIdentity::new(
            "run-1".into(),
            "attempt-1".into(),
            "secret-owner-token".into(),
        );
        let other_cleanup = other_identity.cleanup_receipt();
        assert!(!other_cleanup.proves_quiescence_for(&turn));
    }
}
