use super::super::{FailureCategory, RuntimeError, bounded_string};
use super::{
    MAX_NATIVE_CHAT_EVENT_TYPE_BYTES, MAX_NATIVE_CHAT_SAFE_REFERENCE_BYTES, NativeChatTurnEvent,
    NativeChatTurnEventKind,
};

pub(super) fn validate_event_type(value: &str) -> Result<(), RuntimeError> {
    bounded_metadata(value, "native_event_type", MAX_NATIVE_CHAT_EVENT_TYPE_BYTES)
}

pub(super) fn validate_safe_reference(value: Option<&str>) -> Result<(), RuntimeError> {
    let Some(value) = value else {
        return Ok(());
    };
    bounded_metadata(
        value,
        "native_event_safe_reference",
        MAX_NATIVE_CHAT_SAFE_REFERENCE_BYTES,
    )
}

fn bounded_metadata(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), RuntimeError> {
    bounded_string(value, field, max_bytes)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-+".contains(&byte))
    {
        return Err(RuntimeError::invalid(format!(
            "{field} must contain only safe identifier characters"
        )));
    }
    Ok(())
}

pub(super) fn validate_evidence_sequence(
    sequence: Option<u64>,
    retained_events: &[NativeChatTurnEvent],
    replay_floor: u64,
    last_sequence: Option<u64>,
    predicate: impl Fn(&NativeChatTurnEventKind) -> bool,
    evidence_name: &'static str,
) -> Result<(), RuntimeError> {
    let Some(sequence) = sequence else {
        return Ok(());
    };
    if sequence == 0 {
        return Err(RuntimeError::invalid(format!(
            "native chat checkpoint {evidence_name} sequence must be greater than zero"
        )));
    }
    if sequence > last_sequence.unwrap_or_default() {
        return Err(RuntimeError::invalid(format!(
            "native chat checkpoint {evidence_name} sequence exceeds its last event"
        )));
    }
    if sequence <= replay_floor {
        return Ok(());
    }
    match retained_events
        .iter()
        .find(|event| event.sequence == sequence)
    {
        Some(event) if predicate(&event.event) => Ok(()),
        _ => Err(RuntimeError::invalid(format!(
            "native chat checkpoint {evidence_name} is missing from retained history"
        ))),
    }
}

pub(super) fn stale_identity() -> RuntimeError {
    RuntimeError::new(
        "stale_native_chat_identity",
        FailureCategory::StaleFence,
        "native chat event identity does not match the active turn",
    )
}

pub(super) fn replay_conflict() -> RuntimeError {
    RuntimeError::new(
        "native_chat_event_replay_conflict",
        FailureCategory::IdempotencyConflict,
        "native chat sequence was replayed with different event metadata",
    )
}

pub(super) fn reconciliation_required() -> RuntimeError {
    RuntimeError::new(
        "native_chat_reconciliation_required",
        FailureCategory::Conflict,
        "native chat replay is older than retained history; reconcile before applying it",
    )
}
