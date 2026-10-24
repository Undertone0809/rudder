//! Opaque, connection-bound evidence produced only by `OwnedTransport`.

use crate::TransportError;
pub(crate) use rudder_native_process_transport::ConnectionIdentity as ReceiptIdentity;
use rudder_native_process_transport::HostCleanupProof;
pub use rudder_native_process_transport::{ConnectionLaunchPermit, ConnectionReceipt};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

const MAX_EARLY_EVENTS: usize = 32;
const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_EARLY_BYTES: usize = 1024 * 1024;
const MAX_FINAL_TEXT_BYTES: usize = 256 * 1024;
const MAX_TOKEN_COUNT: u64 = 1_000_000_000_000;
const MAX_FINAL_ITEMS: usize = 1;
const MAX_TRACKED_AGENT_ITEMS: usize = 128;
const MAX_PENDING_DELTA_EVENTS: usize = 32;
const MAX_PENDING_DELTA_BYTES: usize = 1024 * 1024;
// Coalescing preserves small output while bounding full-size answers to a few
// hundred delta receipts; the executor flushes partial chunks at most once/sec.
// A chunk may exceed the target by one Unicode scalar, at most three bytes.
const MAX_FINAL_DELTA_RECEIPT_BYTES: usize = 1024;
const MAX_VISIBLE_OUTPUT_RECEIPTS: usize =
    MAX_FINAL_TEXT_BYTES / MAX_FINAL_DELTA_RECEIPT_BYTES + MAX_FINAL_ITEMS + 1;
const MAX_VISIBLE_OUTPUT_BYTES: usize = 1024 * 1024;
pub struct CleanupReceipt {
    proof: HostCleanupProof,
}

impl CleanupReceipt {
    pub(crate) fn from_host_proof(proof: HostCleanupProof) -> Self {
        Self { proof }
    }

    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.proof
            .matches_execution(run_id, attempt_id, owner_token)
    }

    pub fn proves_quiescence_for(&self, turn: &TurnReceipt) -> bool {
        self.proof.matches_identity(&turn.identity)
    }

    pub fn connection_receipt_id(&self) -> &str {
        self.proof.connection_receipt_id()
    }

    pub fn connection_epoch(&self) -> Option<i32> {
        self.proof.connection_epoch()
    }

    /// Match the one-use launch claim issued with the D1 execution fence. An
    /// epoch alone does not distinguish parallel transports under one owner.
    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        connection_epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.proof.matches_connection_claim(
            run_id,
            attempt_id,
            owner_token,
            connection_epoch,
            claim_id,
        )
    }

    /// Reify only the cleanup's opaque connection identity for a narrow
    /// same-owner Stop registration. This is not a process-launch capability.
    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.proof.connection_receipt()
    }

    pub fn evidence_fingerprint(&self) -> String {
        format!(
            "codex-owned-cleanup-v1:{}",
            self.proof.connection_receipt_id()
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

/// The semantic operation a Native Chat projector must apply to its one
/// assistant message. Delta appends bytes; Snapshot replaces the complete body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VisibleOutputKind {
    Delta,
    Snapshot,
}

/// Opaque evidence emitted only after this connection observes an exact-turn
/// final-answer item. It carries no JSON and has no public/serde constructor.
pub struct VisibleOutputReceipt {
    identity: ReceiptIdentity,
    thread_id: String,
    turn_id: String,
    item_id: String,
    ordinal: u64,
    kind: VisibleOutputKind,
    text: String,
}

impl VisibleOutputReceipt {
    pub fn connection_receipt_id(&self) -> &str {
        self.identity.connection_receipt_id()
    }

    pub fn connection_epoch(&self) -> Option<i32> {
        self.identity.connection_epoch()
    }

    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.identity.matches(run_id, attempt_id, owner_token)
    }

    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        connection_epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.identity.matches_connection_claim(
            run_id,
            attempt_id,
            owner_token,
            connection_epoch,
            claim_id,
        )
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }

    pub fn item_id(&self) -> &str {
        &self.item_id
    }

    /// One-based and contiguous over emitted visible-output receipts on this
    /// connection. Equal delta text is still a separate provider observation.
    pub fn ordinal(&self) -> u64 {
        self.ordinal
    }

    pub fn kind(&self) -> VisibleOutputKind {
        self.kind
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

pub(crate) struct TurnReceiptTracker {
    identity: ReceiptIdentity,
    capture_armed: bool,
    early: VecDeque<(String, Value)>,
    early_bytes: usize,
    active: Option<ActiveTurn>,
    receipt: Option<TurnReceipt>,
    next_visible_ordinal: u64,
    visible_output: VecDeque<VisibleOutputReceipt>,
    visible_output_bytes: usize,
}

struct AgentMessageMetadata {
    phase: Option<String>,
    completed: bool,
}

struct ActiveTurn {
    thread_id: String,
    turn_id: String,
    items: BTreeMap<String, String>,
    usage: Option<TurnUsage>,
    terminal: Option<(TurnStatus, Option<BTreeMap<String, String>>)>,
    agent_messages: BTreeMap<String, AgentMessageMetadata>,
    agent_metadata_incomplete: bool,
    final_answer_item_id: Option<String>,
    started_final_answer_item_id: Option<String>,
    pending_deltas: BTreeMap<String, VecDeque<String>>,
    pending_delta_events: usize,
    pending_delta_bytes: usize,
    pending_final_delta: String,
    final_delta_bytes: usize,
}

struct VisibleOutputCapture<'a> {
    identity: &'a ReceiptIdentity,
    next_ordinal: &'a mut u64,
    receipts: &'a mut VecDeque<VisibleOutputReceipt>,
    bytes: &'a mut usize,
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
            next_visible_ordinal: 1,
            visible_output: VecDeque::new(),
            visible_output_bytes: 0,
        }
    }

    pub(crate) fn observe(&mut self, method: &str, params: Value) -> Result<(), TransportError> {
        if !matches!(
            method,
            "item/started"
                | "item/agentMessage/delta"
                | "item/completed"
                | "thread/tokenUsage/updated"
                | "turn/completed"
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
            let identity = &self.identity;
            let next_ordinal = &mut self.next_visible_ordinal;
            let visible_output = &mut self.visible_output;
            let visible_output_bytes = &mut self.visible_output_bytes;
            let mut output = VisibleOutputCapture {
                identity,
                next_ordinal,
                receipts: visible_output,
                bytes: visible_output_bytes,
            };
            return active.observe(method, params, &mut output);
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
        self.capture_armed = false;
        self.early_bytes = 0;
        let early = std::mem::take(&mut self.early);
        let mut active = ActiveTurn {
            thread_id,
            turn_id,
            items: BTreeMap::new(),
            usage: None,
            terminal: None,
            agent_messages: BTreeMap::new(),
            agent_metadata_incomplete: false,
            final_answer_item_id: None,
            started_final_answer_item_id: None,
            pending_deltas: BTreeMap::new(),
            pending_delta_events: 0,
            pending_delta_bytes: 0,
            pending_final_delta: String::new(),
            final_delta_bytes: 0,
        };
        let mut next_ordinal = self.next_visible_ordinal;
        let mut visible_output = VecDeque::new();
        let mut visible_output_bytes = 0;
        {
            let mut output = VisibleOutputCapture {
                identity: &self.identity,
                next_ordinal: &mut next_ordinal,
                receipts: &mut visible_output,
                bytes: &mut visible_output_bytes,
            };
            for (method, params) in early {
                // Early events are committed as one correlated batch. A later
                // conflict cannot leave earlier candidate output receipts usable.
                active.observe(&method, params, &mut output)?;
            }
        }
        self.next_visible_ordinal = next_ordinal;
        self.visible_output.extend(visible_output);
        self.visible_output_bytes = self
            .visible_output_bytes
            .saturating_add(visible_output_bytes);
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

    pub(crate) fn response_identity(&self) -> ReceiptIdentity {
        self.identity.duplicate_identity()
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
        if final_items.len() > MAX_FINAL_ITEMS {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let final_text = final_items.into_values().next();
        self.receipt = Some(TurnReceipt {
            identity: self.identity.duplicate_identity(),
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

    pub(crate) fn take_visible_output_receipts(&mut self) -> Vec<VisibleOutputReceipt> {
        self.visible_output_bytes = 0;
        self.visible_output.drain(..).collect()
    }

    pub(crate) fn flush_visible_output_deltas(&mut self) -> Result<(), TransportError> {
        let Some(active) = self.active.as_mut() else {
            return Ok(());
        };
        let mut output = VisibleOutputCapture {
            identity: &self.identity,
            next_ordinal: &mut self.next_visible_ordinal,
            receipts: &mut self.visible_output,
            bytes: &mut self.visible_output_bytes,
        };
        active.flush_final_output_delta(&mut output)
    }
}

impl ActiveTurn {
    fn observe(
        &mut self,
        method: &str,
        params: Value,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if self.terminal.is_some() {
            return Ok(());
        }
        match method {
            "item/started" => self.observe_item_started(&params, output),
            "item/agentMessage/delta" => self.observe_delta(&params, output),
            "item/completed" => self.observe_item(&params, output),
            "thread/tokenUsage/updated" => self.observe_usage(&params),
            "turn/completed" => self.observe_terminal(&params, output),
            _ => Ok(()),
        }
    }

    fn observe_item_started(
        &mut self,
        params: &Value,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if !self.matches_turn(params, "threadId", "turnId") {
            return Ok(());
        }
        let item = &params["item"];
        let id = required_locator(&item["id"])?;
        if item["type"] != "agentMessage" {
            if self.final_answer_item_id.as_deref() == Some(id.as_str())
                || self.agent_messages.contains_key(&id)
            {
                return Err(TransportError::InvalidTurnReceipt);
            }
            self.discard_pending_deltas(&id);
            return Ok(());
        }
        let phase = optional_phase(&item["phase"])?;
        if let Some(current) = self.agent_messages.get_mut(&id) {
            if let (Some(previous), Some(next)) = (&current.phase, &phase)
                && previous != next
            {
                return Err(TransportError::InvalidTurnReceipt);
            }
            if current.completed && current.phase.is_none() && phase.is_some() {
                return Err(TransportError::InvalidTurnReceipt);
            }
            if phase.is_some() {
                current.phase = phase.clone();
            }
        } else if phase.as_deref() == Some("final_answer") {
            if self.agent_metadata_incomplete && self.final_answer_item_id.is_none() {
                return Err(TransportError::InvalidTurnReceipt);
            }
        } else if !self.agent_metadata_incomplete
            && self.agent_messages.len() < MAX_TRACKED_AGENT_ITEMS
        {
            self.agent_messages.insert(
                id.clone(),
                AgentMessageMetadata {
                    phase: phase.clone(),
                    completed: false,
                },
            );
        } else {
            self.agent_metadata_incomplete = true;
            self.discard_pending_deltas(&id);
        }

        if let Some(phase) = phase.as_deref() {
            if phase == "final_answer" {
                self.set_final_answer_id(&id)?;
                self.started_final_answer_item_id = Some(id.clone());
                if let Some(current) = self.agent_messages.get_mut(&id) {
                    current.phase = Some(phase.to_owned());
                }
                self.flush_pending_deltas(&id, output)?;
            } else {
                if self.final_answer_item_id.as_deref() == Some(id.as_str()) {
                    return Err(TransportError::InvalidTurnReceipt);
                }
                self.discard_pending_deltas(&id);
            }
        }
        Ok(())
    }

    fn observe_delta(
        &mut self,
        params: &Value,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if !self.matches_turn(params, "threadId", "turnId") {
            return Ok(());
        }
        let item_id = required_locator(&params["itemId"])?;
        let delta = params["delta"]
            .as_str()
            .filter(|delta| delta.len() <= MAX_EVENT_BYTES)
            .ok_or(TransportError::InvalidTurnReceipt)?
            .to_owned();
        if self.started_final_answer_item_id.as_deref() == Some(item_id.as_str()) {
            if self.items.contains_key(&item_id) {
                return Ok(());
            }
            return self.emit_delta(&item_id, delta, output);
        }
        if let Some(metadata) = self.agent_messages.get(&item_id) {
            if metadata.completed
                || metadata
                    .phase
                    .as_deref()
                    .is_some_and(|phase| phase != "final_answer")
            {
                return Ok(());
            }
            // A completed snapshot can identify a final-answer item, but only
            // item/started can authorize delta output (delta has no phase).
            if metadata.phase.as_deref() == Some("final_answer") {
                return Ok(());
            }
        }
        if self.agent_metadata_incomplete {
            return Ok(());
        }
        self.buffer_delta(item_id, delta)
    }

    fn observe_item(
        &mut self,
        params: &Value,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if !self.matches_turn(params, "threadId", "turnId") {
            return Ok(());
        }
        let item = &params["item"];
        let id = required_locator(&item["id"])?;
        if item["type"] != "agentMessage" {
            if self.final_answer_item_id.as_deref() == Some(id.as_str())
                || self.agent_messages.contains_key(&id)
            {
                return Err(TransportError::InvalidTurnReceipt);
            }
            self.discard_pending_deltas(&id);
            return Ok(());
        }
        let phase = optional_phase(&item["phase"])?;
        let metadata = self.agent_messages.get(&id);
        if let (Some(previous), Some(next)) = (
            metadata.and_then(|metadata| metadata.phase.as_deref()),
            phase.as_deref(),
        ) && previous != next
        {
            return Err(TransportError::InvalidTurnReceipt);
        }
        if let Some(metadata) = metadata
            && metadata.completed
        {
            return Err(TransportError::InvalidTurnReceipt);
        }
        if phase.as_deref() == Some("final_answer") {
            if self.agent_metadata_incomplete
                && !self.agent_messages.contains_key(&id)
                && self.final_answer_item_id.as_deref() != Some(id.as_str())
            {
                return Err(TransportError::InvalidTurnReceipt);
            }
            self.set_final_answer_id(&id)?;
        } else if self.final_answer_item_id.as_deref() == Some(id.as_str()) && phase.is_some() {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let effective_final = phase.as_deref() == Some("final_answer")
            || (phase.is_none()
                && (self.final_answer_item_id.as_deref() == Some(id.as_str())
                    || self
                        .agent_messages
                        .get(&id)
                        .and_then(|metadata| metadata.phase.as_deref())
                        == Some("final_answer")));
        let metadata_slot_available = self.agent_messages.contains_key(&id)
            || self.agent_messages.len() < MAX_TRACKED_AGENT_ITEMS;
        if let Some(metadata) = self.agent_messages.get_mut(&id) {
            metadata.phase = phase.clone().or_else(|| metadata.phase.clone());
            metadata.completed = true;
        } else if metadata_slot_available {
            self.agent_messages.insert(
                id.clone(),
                AgentMessageMetadata {
                    phase: phase.clone(),
                    completed: true,
                },
            );
        } else {
            self.agent_metadata_incomplete = true;
        }
        self.discard_pending_deltas(&id);
        if !effective_final {
            return Ok(());
        }
        let text = item["text"]
            .as_str()
            .filter(|text| text.len() <= MAX_FINAL_TEXT_BYTES)
            .ok_or(TransportError::InvalidTurnReceipt)?
            .to_owned();
        insert_item(&mut self.items, id.clone(), text.clone())?;
        self.flush_final_output_delta(output)?;
        self.emit_output(&id, VisibleOutputKind::Snapshot, text, output)
    }

    fn observe_usage(&mut self, params: &Value) -> Result<(), TransportError> {
        if !self.matches_turn(params, "threadId", "turnId") {
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
        // Updates replace the latest model-response increment. They are not
        // cumulative turn totals and do not consume an event-count budget.
        self.usage = Some(usage);
        Ok(())
    }

    fn observe_terminal(
        &mut self,
        params: &Value,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if !self.matches_turn(params, "threadId", "turn.id") {
            return Ok(());
        }
        let status = match params["turn"]["status"].as_str() {
            Some("completed") => TurnStatus::Completed,
            Some("failed") => TurnStatus::Failed,
            Some("interrupted") => TurnStatus::Interrupted,
            _ => return Err(TransportError::InvalidTurnReceipt),
        };
        self.flush_final_output_delta(output)?;
        let items_view = params["turn"]["itemsView"].as_str().unwrap_or("full");
        let terminal_items = match items_view {
            "full" => {
                let items = params["turn"]["items"]
                    .as_array()
                    .ok_or(TransportError::InvalidTurnReceipt)?;
                let mut final_items = BTreeMap::new();
                for item in items {
                    let id = required_locator(&item["id"])?;
                    if item["type"] != "agentMessage" {
                        if self.final_answer_item_id.as_deref() == Some(id.as_str()) {
                            return Err(TransportError::InvalidTurnReceipt);
                        }
                        continue;
                    }
                    let phase = optional_phase(&item["phase"])?;
                    if let (Some(previous), Some(next)) = (
                        self.agent_messages
                            .get(&id)
                            .and_then(|metadata| metadata.phase.as_deref()),
                        phase.as_deref(),
                    ) && previous != next
                    {
                        return Err(TransportError::InvalidTurnReceipt);
                    }
                    let known_final = self.final_answer_item_id.as_deref() == Some(id.as_str());
                    let started_phase = self
                        .agent_messages
                        .get(&id)
                        .and_then(|metadata| metadata.phase.as_deref());
                    let effective_final = phase.as_deref() == Some("final_answer")
                        || (phase.is_none()
                            && (known_final || started_phase == Some("final_answer")));
                    if phase.as_deref() == Some("final_answer") {
                        if self.agent_metadata_incomplete
                            && !self.agent_messages.contains_key(&id)
                            && !known_final
                        {
                            return Err(TransportError::InvalidTurnReceipt);
                        }
                        self.set_final_answer_id(&id)?;
                    } else if known_final && phase.is_some() {
                        return Err(TransportError::InvalidTurnReceipt);
                    }
                    if effective_final {
                        let text = item["text"]
                            .as_str()
                            .filter(|text| text.len() <= MAX_FINAL_TEXT_BYTES)
                            .ok_or(TransportError::InvalidTurnReceipt)?
                            .to_owned();
                        insert_item(&mut final_items, id.clone(), text)?;
                    }
                }
                if final_items.len() > MAX_FINAL_ITEMS {
                    return Err(TransportError::InvalidTurnReceipt);
                }
                for (id, text) in &final_items {
                    if let Some(observed) = self.items.get(id) {
                        if observed != text {
                            return Err(TransportError::InvalidTurnReceipt);
                        }
                    } else {
                        insert_item(&mut self.items, id.clone(), text.clone())?;
                        self.discard_pending_deltas(id);
                        self.emit_output(id, VisibleOutputKind::Snapshot, text.clone(), output)?;
                    }
                }
                Some(final_items)
            }
            "summary" | "notLoaded" => None,
            _ => return Err(TransportError::InvalidTurnReceipt),
        };
        self.pending_deltas.clear();
        self.pending_delta_events = 0;
        self.pending_delta_bytes = 0;
        self.terminal = Some((status, terminal_items));
        Ok(())
    }

    fn matches_turn(&self, params: &Value, thread_key: &str, turn_key: &str) -> bool {
        let turn_id = if turn_key == "turn.id" {
            exact_locator(&params["turn"]["id"])
        } else {
            exact_locator(&params[turn_key])
        };
        exact_locator(&params[thread_key]) == Some(self.thread_id.as_str())
            && turn_id == Some(self.turn_id.as_str())
    }

    fn set_final_answer_id(&mut self, item_id: &str) -> Result<(), TransportError> {
        match self.final_answer_item_id.as_deref() {
            Some(existing) if existing != item_id => Err(TransportError::InvalidTurnReceipt),
            Some(_) => Ok(()),
            None => {
                self.final_answer_item_id = Some(item_id.to_owned());
                Ok(())
            }
        }
    }

    fn buffer_delta(&mut self, item_id: String, delta: String) -> Result<(), TransportError> {
        if self.pending_delta_events >= MAX_PENDING_DELTA_EVENTS
            || self.pending_delta_bytes.saturating_add(delta.len()) > MAX_PENDING_DELTA_BYTES
        {
            return Err(TransportError::InvalidTurnReceipt);
        }
        self.pending_delta_events += 1;
        self.pending_delta_bytes += delta.len();
        self.pending_deltas
            .entry(item_id)
            .or_default()
            .push_back(delta);
        Ok(())
    }

    fn discard_pending_deltas(&mut self, item_id: &str) {
        if let Some(deltas) = self.pending_deltas.remove(item_id) {
            self.pending_delta_events = self.pending_delta_events.saturating_sub(deltas.len());
            self.pending_delta_bytes = self
                .pending_delta_bytes
                .saturating_sub(deltas.iter().map(String::len).sum::<usize>());
        }
    }

    fn flush_pending_deltas(
        &mut self,
        item_id: &str,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        let Some(deltas) = self.pending_deltas.remove(item_id) else {
            return Ok(());
        };
        self.pending_delta_events = self.pending_delta_events.saturating_sub(deltas.len());
        self.pending_delta_bytes = self
            .pending_delta_bytes
            .saturating_sub(deltas.iter().map(String::len).sum::<usize>());
        if self.items.contains_key(item_id) {
            return Ok(());
        }
        for delta in deltas {
            self.emit_delta(item_id, delta, output)?;
        }
        Ok(())
    }

    fn emit_delta(
        &mut self,
        item_id: &str,
        delta: String,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if self.final_answer_item_id.as_deref() != Some(item_id) {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let total = self
            .final_delta_bytes
            .checked_add(delta.len())
            .filter(|total| *total <= MAX_FINAL_TEXT_BYTES)
            .ok_or(TransportError::InvalidTurnReceipt)?;
        self.final_delta_bytes = total;
        for character in delta.chars() {
            self.pending_final_delta.push(character);
            if self.pending_final_delta.len() >= MAX_FINAL_DELTA_RECEIPT_BYTES {
                self.flush_final_output_delta(output)?;
            }
        }
        Ok(())
    }

    fn flush_final_output_delta(
        &mut self,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if self.pending_final_delta.is_empty() {
            return Ok(());
        }
        let item_id = self
            .final_answer_item_id
            .as_deref()
            .ok_or(TransportError::InvalidTurnReceipt)?;
        let text = std::mem::take(&mut self.pending_final_delta);
        self.emit_output(item_id, VisibleOutputKind::Delta, text, output)
    }

    fn emit_output(
        &self,
        item_id: &str,
        kind: VisibleOutputKind,
        text: String,
        output: &mut VisibleOutputCapture<'_>,
    ) -> Result<(), TransportError> {
        if text.len() > MAX_FINAL_TEXT_BYTES
            || output.receipts.len() >= MAX_VISIBLE_OUTPUT_RECEIPTS
            || output.bytes.saturating_add(text.len()) > MAX_VISIBLE_OUTPUT_BYTES
        {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let ordinal = *output.next_ordinal;
        *output.next_ordinal = ordinal
            .checked_add(1)
            .ok_or(TransportError::InvalidTurnReceipt)?;
        *output.bytes += text.len();
        output.receipts.push_back(VisibleOutputReceipt {
            identity: output.identity.duplicate_identity(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            item_id: item_id.to_owned(),
            ordinal,
            kind,
            text,
        });
        Ok(())
    }
}

fn optional_phase(value: &Value) -> Result<Option<String>, TransportError> {
    if value.is_null() {
        return Ok(None);
    }
    let phase = value
        .as_str()
        .filter(|phase| !phase.is_empty() && phase.len() <= 128)
        .ok_or(TransportError::InvalidTurnReceipt)?;
    Ok(Some(phase.to_owned()))
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
        let mut tracker = TurnReceiptTracker::new(ReceiptIdentity::unbound(
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

    fn started(thread: &str, turn: &str, id: &str, phase: Option<&str>) -> Value {
        json!({"threadId":thread,"turnId":turn,"startedAtMs":1,"item":{
            "id":id,"type":"agentMessage","phase":phase
        }})
    }

    fn delta(thread: &str, turn: &str, id: &str, text: &str) -> Value {
        json!({"threadId":thread,"turnId":turn,"itemId":id,"delta":text})
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
        let mut tracker = TurnReceiptTracker::new(ReceiptIdentity::unbound(
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
    fn visible_deltas_wait_for_exact_final_answer_metadata_and_coalesce_duplicate_chunks() {
        let identity = ReceiptIdentity::unbound(
            "run-1".into(),
            "attempt-1".into(),
            "secret-owner-token".into(),
        );
        let mut tracker = TurnReceiptTracker::new(identity);
        tracker.arm().unwrap();

        // The transport cannot know the turn ID until the start response. These
        // events are retained and later correlated against the exact result.
        tracker
            .observe(
                "item/started",
                started(
                    "other-thread",
                    "turn-1",
                    "foreign-item",
                    Some("final_answer"),
                ),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("other-thread", "turn-1", "foreign-item", "must ignore"),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "ha"),
            )
            .unwrap();
        tracker
            .observe(
                "item/started",
                started("thread-1", "turn-1", "answer-1", Some("final_answer")),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "ha"),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "ha"),
            )
            .unwrap();
        tracker
            .observe(
                "item/completed",
                json!({"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"hahaha"
                }}),
            )
            .unwrap();
        tracker
            .observe(
                "turn/completed",
                json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","itemsView":"full","items":[{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"hahaha"
                }]}}),
            )
            .unwrap();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();

        let outputs = tracker.take_visible_output_receipts();
        assert_eq!(outputs.len(), 2);
        assert_eq!(
            outputs
                .iter()
                .map(VisibleOutputReceipt::ordinal)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(
            outputs
                .iter()
                .map(VisibleOutputReceipt::text)
                .collect::<Vec<_>>(),
            ["hahaha", "hahaha"]
        );
        assert_eq!(
            outputs
                .iter()
                .map(VisibleOutputReceipt::kind)
                .collect::<Vec<_>>(),
            [VisibleOutputKind::Delta, VisibleOutputKind::Snapshot]
        );
        for output in &outputs {
            assert_eq!(output.thread_id(), "thread-1");
            assert_eq!(output.turn_id(), "turn-1");
            assert_eq!(output.item_id(), "answer-1");
            assert_eq!(
                output.connection_receipt_id(),
                outputs[0].connection_receipt_id()
            );
            assert_eq!(output.connection_epoch(), None);
            assert!(!output.matches_connection_claim(
                "run-1",
                "attempt-1",
                "secret-owner-token",
                7,
                "claim-1",
            ));
            assert!(!output.matches_connection_claim(
                "run-1",
                "attempt-2",
                "secret-owner-token",
                7,
                "claim-1",
            ));
            assert!(!output.matches_connection_claim(
                "run-1",
                "attempt-1",
                "secret-owner-token",
                8,
                "claim-1",
            ));
            assert!(!output.matches_connection_claim(
                "run-1",
                "attempt-1",
                "secret-owner-token",
                7,
                "other-claim",
            ));
        }
    }

    #[test]
    fn explicit_partial_flush_keeps_output_ordinals_contiguous() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/started",
                started("thread-1", "turn-1", "answer-1", Some("final_answer")),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "same"),
            )
            .unwrap();
        tracker.flush_visible_output_deltas().unwrap();
        let first = tracker.take_visible_output_receipts();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].ordinal(), 1);

        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "same"),
            )
            .unwrap();
        assert!(tracker.take_visible_output_receipts().is_empty());
        tracker.flush_visible_output_deltas().unwrap();
        let second = tracker.take_visible_output_receipts();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].ordinal(), 2);
        assert_eq!(second[0].text(), first[0].text());
    }

    #[test]
    fn thousands_of_tiny_utf8_deltas_coalesce_without_changing_text_or_order() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/started",
                started("thread-1", "turn-1", "answer-1", Some("final_answer")),
            )
            .unwrap();

        let expected = "🧭".repeat(6_001);
        for _ in 0..6_001 {
            tracker
                .observe(
                    "item/agentMessage/delta",
                    delta("thread-1", "turn-1", "answer-1", "🧭"),
                )
                .unwrap();
        }
        tracker.flush_visible_output_deltas().unwrap();
        let mut outputs = tracker.take_visible_output_receipts();
        let delta_count = outputs
            .iter()
            .filter(|receipt| receipt.kind() == VisibleOutputKind::Delta)
            .count();
        let reconstructed = outputs
            .iter()
            .filter(|receipt| receipt.kind() == VisibleOutputKind::Delta)
            .map(VisibleOutputReceipt::text)
            .collect::<String>();
        assert_eq!(reconstructed, expected);
        assert!(delta_count <= expected.len().div_ceil(MAX_FINAL_DELTA_RECEIPT_BYTES));
        assert!(
            outputs
                .windows(2)
                .all(|pair| pair[0].ordinal() + 1 == pair[1].ordinal())
        );

        tracker
            .observe(
                "item/completed",
                json!({"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":expected
                }}),
            )
            .unwrap();
        outputs.extend(tracker.take_visible_output_receipts());
        assert_eq!(outputs.last().unwrap().kind(), VisibleOutputKind::Snapshot);
        assert_eq!(outputs.last().unwrap().text(), expected);
        tracker
            .observe(
                "turn/completed",
                json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","itemsView":"full","items":[{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":expected
                }]}}),
            )
            .unwrap();
        assert!(tracker.take_visible_output_receipts().is_empty());
        tracker.finish().unwrap();
        assert_eq!(
            tracker.take().unwrap().final_text(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn large_single_delta_is_chunked_and_stays_below_visible_output_receipt_cap() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/started",
                started("thread-1", "turn-1", "answer-1", Some("final_answer")),
            )
            .unwrap();

        let expected = "x".repeat(MAX_FINAL_TEXT_BYTES - 4 * 1024);
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", &expected),
            )
            .unwrap();
        let mut outputs = tracker.take_visible_output_receipts();
        tracker.flush_visible_output_deltas().unwrap();
        outputs.extend(tracker.take_visible_output_receipts());

        let delta_text = outputs
            .iter()
            .filter(|receipt| receipt.kind() == VisibleOutputKind::Delta)
            .map(VisibleOutputReceipt::text)
            .collect::<String>();
        assert_eq!(delta_text, expected);
        assert_eq!(
            outputs
                .iter()
                .filter(|receipt| receipt.kind() == VisibleOutputKind::Delta)
                .count(),
            expected.len().div_ceil(MAX_FINAL_DELTA_RECEIPT_BYTES)
        );

        tracker
            .observe(
                "item/completed",
                json!({"threadId":"thread-1","turnId":"turn-1","completedAtMs":3,"item":{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":expected
                }}),
            )
            .unwrap();
        outputs.extend(tracker.take_visible_output_receipts());
        assert_eq!(
            outputs.len(),
            expected.len().div_ceil(MAX_FINAL_DELTA_RECEIPT_BYTES) + 1
        );
        assert!(outputs.len() < 4_096);
        assert_eq!(outputs.last().unwrap().kind(), VisibleOutputKind::Snapshot);
        assert_eq!(outputs.last().unwrap().text(), expected);
    }

    #[test]
    fn worst_case_partial_flushes_and_final_snapshot_stay_below_durable_cap() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/started",
                started("thread-1", "turn-1", "answer-1", Some("final_answer")),
            )
            .unwrap();

        // A Native Chat turn can run for at most one hour. Simulate one
        // non-empty timer flush per second, then fill the rest of the largest
        // snapshot that leaves room for its JSON envelope. Count all delta
        // receipts and the final snapshot, including receipts later labeled
        // runtime_output.
        const MAX_PARTIAL_FLUSHES_PER_TURN: usize = 3_600;
        const SNAPSHOT_ENVELOPE_HEADROOM: usize = 4 * 1024;
        let target_text_bytes = MAX_FINAL_TEXT_BYTES - SNAPSHOT_ENVELOPE_HEADROOM;
        let mut expected = String::new();
        let mut outputs = Vec::new();
        for _ in 0..MAX_PARTIAL_FLUSHES_PER_TURN {
            expected.push('x');
            tracker
                .observe(
                    "item/agentMessage/delta",
                    delta("thread-1", "turn-1", "answer-1", "x"),
                )
                .unwrap();
            tracker.flush_visible_output_deltas().unwrap();
            outputs.extend(tracker.take_visible_output_receipts());
        }

        let remaining = target_text_bytes - expected.len();
        let full_chunk = "y".repeat(MAX_FINAL_DELTA_RECEIPT_BYTES);
        for _ in 0..remaining / MAX_FINAL_DELTA_RECEIPT_BYTES {
            expected.push_str(&full_chunk);
            tracker
                .observe(
                    "item/agentMessage/delta",
                    delta("thread-1", "turn-1", "answer-1", &full_chunk),
                )
                .unwrap();
            outputs.extend(tracker.take_visible_output_receipts());
        }
        let remainder = remaining % MAX_FINAL_DELTA_RECEIPT_BYTES;
        if remainder > 0 {
            let tail = "y".repeat(remainder);
            expected.push_str(&tail);
            tracker
                .observe(
                    "item/agentMessage/delta",
                    delta("thread-1", "turn-1", "answer-1", &tail),
                )
                .unwrap();
        }
        tracker.flush_visible_output_deltas().unwrap();
        outputs.extend(tracker.take_visible_output_receipts());
        tracker
            .observe(
                "item/completed",
                json!({"threadId":"thread-1","turnId":"turn-1","completedAtMs":4,"item":{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":expected
                }}),
            )
            .unwrap();
        outputs.extend(tracker.take_visible_output_receipts());
        tracker
            .observe(
                "turn/completed",
                json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","itemsView":"full","items":[{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":expected
                }]}}),
            )
            .unwrap();
        assert!(
            tracker.take_visible_output_receipts().is_empty(),
            "the terminal item snapshot does not duplicate the final projection"
        );
        tracker.finish().unwrap();

        let deltas = outputs
            .iter()
            .filter(|receipt| receipt.kind() == VisibleOutputKind::Delta)
            .map(VisibleOutputReceipt::text)
            .collect::<String>();
        assert_eq!(deltas, expected);
        assert_eq!(outputs.last().unwrap().kind(), VisibleOutputKind::Snapshot);
        assert_eq!(outputs.last().unwrap().text(), expected);
        assert!(
            outputs
                .windows(2)
                .all(|pair| pair[0].ordinal() + 1 == pair[1].ordinal())
        );

        let conservative_bound = MAX_PARTIAL_FLUSHES_PER_TURN
            + MAX_FINAL_TEXT_BYTES.div_ceil(MAX_FINAL_DELTA_RECEIPT_BYTES)
            + 1; // final reconciled snapshot
        assert_eq!(conservative_bound, 3_857);
        assert!(outputs.len() <= conservative_bound);
        assert!(outputs.len() < 4_096);
    }

    #[test]
    fn terminal_flushes_partial_delta_and_does_not_leak_it_to_the_next_turn() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/started",
                started("thread-1", "turn-1", "answer-1", Some("final_answer")),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "short tail"),
            )
            .unwrap();
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        let outputs = tracker.take_visible_output_receipts();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].text(), "short tail");
        tracker.finish().unwrap();
        tracker.take().unwrap();

        tracker.arm().unwrap();
        tracker
            .begin_turn("thread-1".into(), "turn-2".into())
            .unwrap();
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-2"))
            .unwrap();
        assert!(tracker.take_visible_output_receipts().is_empty());
        tracker.finish().unwrap();
        assert_eq!(tracker.take().unwrap().final_text(), None);
    }

    #[test]
    fn terminal_full_snapshot_is_emitted_when_item_completion_was_not_observed() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "partial"),
            )
            .unwrap();
        tracker
            .observe(
                "turn/completed",
                json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","itemsView":"full","items":[{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"authoritative snapshot"
                }]}}),
            )
            .unwrap();
        let outputs = tracker.take_visible_output_receipts();
        assert_eq!(outputs.len(), 1, "unclassified delta must not leak");
        assert_eq!(outputs[0].ordinal(), 1);
        assert_eq!(outputs[0].kind(), VisibleOutputKind::Snapshot);
        assert_eq!(outputs[0].text(), "authoritative snapshot");
        tracker.finish().unwrap();
        assert_eq!(
            tracker.take().unwrap().final_text(),
            Some("authoritative snapshot")
        );
    }

    #[test]
    fn completed_snapshot_does_not_retroactively_authorize_deltas() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "unclassified"),
            )
            .unwrap();
        tracker
            .observe(
                "item/completed",
                json!({"threadId":"thread-1","turnId":"turn-1","item":{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"snapshot"
                }}),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "answer-1", "late delta"),
            )
            .unwrap();
        let outputs = tracker.take_visible_output_receipts();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].kind(), VisibleOutputKind::Snapshot);
        assert_eq!(outputs[0].text(), "snapshot");
    }

    #[test]
    fn nonfinal_started_metadata_drops_pending_deltas_and_never_emits_them() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "commentary-1", "private"),
            )
            .unwrap();
        tracker
            .observe(
                "item/started",
                started("thread-1", "turn-1", "commentary-1", Some("commentary")),
            )
            .unwrap();
        tracker
            .observe(
                "item/agentMessage/delta",
                delta("thread-1", "turn-1", "commentary-1", " still private"),
            )
            .unwrap();
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        assert!(tracker.take_visible_output_receipts().is_empty());
        tracker.finish().unwrap();
        assert_eq!(tracker.take().unwrap().final_text(), None);
    }

    #[test]
    fn conflicting_phase_metadata_and_multiple_final_items_fail_closed() {
        let mut phase_conflict = tracker();
        phase_conflict
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        phase_conflict
            .observe(
                "item/started",
                started("thread-1", "turn-1", "answer-1", Some("commentary")),
            )
            .unwrap();
        let conflicting = json!({"threadId":"thread-1","turnId":"turn-1","item":{
            "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"must reject"
        }});
        assert!(
            phase_conflict
                .observe("item/completed", conflicting)
                .is_err()
        );
        assert!(phase_conflict.take_visible_output_receipts().is_empty());

        let mut two_answers = tracker();
        two_answers
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        two_answers
            .observe(
                "item/completed",
                json!({"threadId":"thread-1","turnId":"turn-1","item":{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"one"
                }}),
            )
            .unwrap();
        assert!(
            two_answers
                .observe(
                    "item/completed",
                    json!({"threadId":"thread-1","turnId":"turn-1","item":{
                        "id":"answer-2","type":"agentMessage","phase":"final_answer","text":"two"
                    }}),
                )
                .is_err()
        );
    }

    #[test]
    fn terminal_full_snapshot_must_match_the_prior_item_snapshot() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        tracker
            .observe(
                "item/completed",
                json!({"threadId":"thread-1","turnId":"turn-1","item":{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"first snapshot"
                }}),
            )
            .unwrap();
        assert!(tracker
            .observe(
                "turn/completed",
                json!({"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","itemsView":"full","items":[{
                    "id":"answer-1","type":"agentMessage","phase":"final_answer","text":"conflicting snapshot"
                }]}}),
            )
            .is_err());
    }

    #[test]
    fn long_tool_and_usage_observations_do_not_hit_a_lifetime_event_count_cap() {
        let mut tracker = tracker();
        tracker
            .begin_turn("thread-1".into(), "turn-1".into())
            .unwrap();
        for count in 0..300u64 {
            let observation = json!({"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{
                "totalTokens":count,"inputTokens":count,"cachedInputTokens":0,
                "outputTokens":0,"reasoningOutputTokens":0
            }}});
            tracker
                .observe("thread/tokenUsage/updated", observation)
                .unwrap();
            tracker
                .observe(
                    "item/completed",
                    json!({"threadId":"thread-1","turnId":"turn-1","item":{
                        "id":format!("tool-{count}"),"type":"commandExecution","command":"echo ok"
                    }}),
                )
                .unwrap();
        }
        tracker
            .observe("turn/completed", terminal("thread-1", "turn-1"))
            .unwrap();
        tracker.finish().unwrap();
        let receipt = tracker.take().unwrap();
        assert_eq!(receipt.usage().unwrap().total_tokens(), 299);
        assert!(tracker.take_visible_output_receipts().is_empty());
    }
}
