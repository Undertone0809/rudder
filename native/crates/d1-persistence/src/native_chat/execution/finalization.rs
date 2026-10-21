//! Single-primary-turn finalization. Only validated receipts from the owned
//! transport enter here; provider completion alone cannot release admission.
use super::{ExecutionFence, Result, context::lock_current_execution, http, output};
use crate::{
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    native_chat::{NativeChatExecutionActor, auth},
    runtime_bindings,
};
use rudder_codex_app_server::{CleanupReceipt, TurnReceipt, TurnStatus};
use rudder_hermes_acp::{
    HermesCleanupReceipt, HermesPromptErrorAfterCancel, HermesStopReason, HermesTurnReceipt,
};
use rudder_native_process_transport::HostCleanupProof;
use rudder_pi_rpc::{PiCleanupReceipt, PiTurnReceipt, PiTurnStatus};
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

const MAX_PROJECTED_BODY_BYTES: i32 = 256 * 1024;
const MAX_NATIVE_ID_BYTES: usize = 512;
const MAX_HERMES_PROGRESS_EVENTS: usize = 512;
const MAX_HERMES_PROGRESS_BYTES: usize = 2 * 1024 * 1024;

async fn validate_hermes_progress_for_terminal(
    tx: &mut auth::Tx<'_>,
    fence: &ExecutionFence,
    turn: ProviderTurn<'_>,
    cleanup: &HermesCleanupReceipt,
    assistant_message_id: &str,
    require_progress: bool,
) -> Result<()> {
    let id = fence.identity();
    let (connection, session, request_id, source_message_id, input_fingerprint) = match turn {
        ProviderTurn::Hermes(turn) => (
            turn.connection_receipt_id(),
            turn.session().as_str(),
            turn.request_id(),
            turn.user_message_id(),
            turn.input_fingerprint(),
        ),
        ProviderTurn::HermesPromptError(error) => (
            error.connection_receipt_id(),
            error.session().as_str(),
            error.request_id(),
            error.user_message_id(),
            error.input_fingerprint(),
        ),
        _ => return Err(http(409, "Hermes progress requires a typed prompt receipt")),
    };
    if connection != cleanup.connection_receipt_id() {
        return Err(http(409, "Hermes progress connection receipt changed"));
    }
    let rows = sqlx::query(
        "SELECT generation_seq,attempt_epoch,assistant_message_id::text,
                payload,octet_length(payload::text)::bigint AS payload_bytes
         FROM chat_generation_events
         WHERE org_id=$1::uuid AND generation_id=$2::uuid AND run_id=$3::uuid
           AND attempt_epoch=$4 AND event_kind='transcript'
         ORDER BY generation_seq LIMIT $5",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.run_id)
    .bind(id.generation_attempt_epoch)
    .bind(MAX_HERMES_PROGRESS_EVENTS as i64 + 1)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() > MAX_HERMES_PROGRESS_EVENTS {
        return Err(http(409, "Hermes progress exceeds its event bound"));
    }
    let mut total_bytes = 0usize;
    let mut expected_ordinal = 1u64;
    for row in &rows {
        // A progress commit can precede Stop while remaining ahead of the
        // client's rendered cutoff. Validate its ownership too; readers and
        // the frozen projection enforce visibility, not receipt finalization.
        let attempt_epoch: i32 = row.try_get("attempt_epoch")?;
        let message_id: Option<String> = row.try_get("assistant_message_id")?;
        if message_id.as_deref() != Some(assistant_message_id) {
            return Err(http(409, "Hermes progress assistant projection changed"));
        }
        let payload_bytes: i64 = row.try_get("payload_bytes")?;
        total_bytes = total_bytes.saturating_add(payload_bytes.max(0) as usize);
        if total_bytes > MAX_HERMES_PROGRESS_BYTES {
            return Err(http(409, "Hermes progress exceeds its byte bound"));
        }
        let payload: Value = row.try_get("payload")?;
        let projection = super::hermes_progress::validate_receipt_projection(
            &payload,
            id.organization_id,
            id.generation_id,
            id.run_id,
            attempt_epoch,
            assistant_message_id,
            fence,
            cleanup.connection_receipt_id(),
            session,
            request_id,
            source_message_id,
            input_fingerprint,
        )
        .ok_or_else(|| http(409, "Hermes progress does not match terminal receipts"))?;
        if projection.ordinal != expected_ordinal {
            return Err(http(409, "Hermes progress ordinal is not contiguous"));
        }
        expected_ordinal += 1;
    }
    if require_progress && rows.is_empty() {
        return Err(http(
            409,
            "Hermes answer has no durable progress projection",
        ));
    }
    Ok(())
}

/// Provider-native terminal evidence for adapters that do not expose Codex
/// Thread/Turn identifiers. The worker must copy only bounded fields from the
/// typed provider receipt; this value is never deserialized from HTTP input.
#[derive(Clone, Debug)]
pub struct NativeProviderTurnReceipt {
    pub provider: NativeProviderKind,
    pub session_id: String,
    pub request_id: String,
    pub final_text: Option<String>,
    pub status: NativeProviderStatus,
    pub usage: Option<Value>,
    pub evidence: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeProviderKind {
    Claude,
    Cursor,
    OpenCode,
}

impl NativeProviderKind {
    pub const fn runtime_type(self) -> &'static str {
        match self {
            Self::Claude => "claude_local",
            Self::Cursor => "cursor_local",
            Self::OpenCode => "opencode_local",
        }
    }

    pub const fn checkpoint_provider(self) -> &'static str {
        match self {
            Self::Claude => "claude_local",
            Self::Cursor => "cursor_local",
            Self::OpenCode => "open_code_local",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeProviderStatus {
    Completed,
    Failed,
    Interrupted,
}

/// Atomically project a supported answer and close the exact owned execution.
/// This private path records unknown cost, never a fabricated zero charge.
/// Applicable billed-cost hard stops remain unsupported and retain the holds.
pub async fn finalize(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    turn: &TurnReceipt,
    cleanup: &CleanupReceipt,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        Some(ProviderTurn::Codex(turn)),
        ProviderCleanup::Codex(cleanup),
        None,
        false,
    )
    .await
}

/// Atomically project a terminal Hermes ACP answer and close the exact owned
/// execution. The Hermes session selector is checked against its private D1
/// checkpoint and Segment; it is never represented as a Codex Thread/Turn.
pub async fn finalize_hermes(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    turn: &HermesTurnReceipt,
    cleanup: &HermesCleanupReceipt,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        Some(ProviderTurn::Hermes(turn)),
        ProviderCleanup::Hermes(cleanup),
        None,
        false,
    )
    .await
}

/// Atomically project a terminal Pi session-tree answer and close the exact
/// owned execution. Pi identities remain provider-native in the receipt and
/// finalization selector; they are never mapped to Codex Thread/Turn fields.
pub async fn finalize_pi(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    turn: &PiTurnReceipt,
    cleanup: &PiCleanupReceipt,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        Some(ProviderTurn::Pi(turn)),
        ProviderCleanup::Pi(cleanup),
        None,
        false,
    )
    .await
}

/// Atomically project Claude Code or Cursor ACP terminal evidence. Provider
/// session/request IDs stay in provider-specific checkpoint fields and are
/// never copied into `provider_thread_id` or `provider_turn_id`.
pub async fn finalize_native(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    turn: &NativeProviderTurnReceipt,
    cleanup: &HostCleanupProof,
) -> Result<Value> {
    validate_native_receipt(turn)?;
    finalize_inner(
        pool,
        actor,
        fence,
        Some(ProviderTurn::Native(turn)),
        ProviderCleanup::Host(cleanup),
        None,
        false,
    )
    .await
}

fn validate_native_receipt(turn: &NativeProviderTurnReceipt) -> Result<()> {
    if turn.session_id.trim().is_empty()
        || turn.session_id.len() > MAX_NATIVE_ID_BYTES
        || turn.request_id.trim().is_empty()
        || turn.request_id.len() > MAX_NATIVE_ID_BYTES
    {
        return Err(http(422, "Native provider receipt identity is invalid"));
    }
    if turn
        .final_text
        .as_deref()
        .is_some_and(|text| text.len() > MAX_PROJECTED_BODY_BYTES as usize)
    {
        return Err(http(422, "Native provider final answer exceeds its bound"));
    }
    let evidence_bytes = serde_json::to_vec(&turn.evidence)
        .map_err(|_| http(422, "Native provider evidence is invalid"))?;
    if evidence_bytes.len() > MAX_PROJECTED_BODY_BYTES as usize {
        return Err(http(422, "Native provider evidence exceeds its bound"));
    }
    if let Some(usage) = &turn.usage {
        let usage_bytes =
            serde_json::to_vec(usage).map_err(|_| http(422, "Native provider usage is invalid"))?;
        if usage_bytes.len() > MAX_PROJECTED_BODY_BYTES as usize {
            return Err(http(422, "Native provider usage exceeds its bound"));
        }
    }
    Ok(())
}

/// Resolve operator Stop only from the exact terminal and same-connection
/// cleanup receipts. Provider status stays evidence; the operator outcome is cancelled.
pub async fn finalize_stopped(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    turn: &TurnReceipt,
    cleanup: &CleanupReceipt,
    stop: &super::stopping::StopIntent,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        Some(ProviderTurn::Codex(turn)),
        ProviderCleanup::Codex(cleanup),
        Some(stop),
        false,
    )
    .await
}

/// Resolve operator Stop from a same-connection Hermes terminal and cleanup
/// receipt. This never manufactures Codex identifiers or provider success.
pub async fn finalize_hermes_stopped(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    turn: &HermesTurnReceipt,
    cleanup: &HermesCleanupReceipt,
    stop: &super::stopping::StopIntent,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        Some(ProviderTurn::Hermes(turn)),
        ProviderCleanup::Hermes(cleanup),
        Some(stop),
        false,
    )
    .await
}

/// Resolve an exact operator Stop after the current prompt RPC ended with an
/// error response following cancellation. This is neither a cancelled turn nor
/// a pre-submission result; the numeric provider error remains explicit.
pub async fn finalize_hermes_prompt_error_stopped(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    error: &HermesPromptErrorAfterCancel,
    cleanup: &HermesCleanupReceipt,
    stop: &super::stopping::StopIntent,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        Some(ProviderTurn::HermesPromptError(error)),
        ProviderCleanup::Hermes(cleanup),
        Some(stop),
        false,
    )
    .await
}

/// Cancel a claimed execution only when the durable checkpoint proves the
/// user input never crossed its effect-permit boundary. This is not a provider
/// terminal receipt; it preserves the frozen Stop projection and reports no
/// fabricated usage or cost.
pub async fn finalize_stopped_before_submission(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    cleanup: &CleanupReceipt,
    stop: &super::stopping::StopIntent,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        None,
        ProviderCleanup::Codex(cleanup),
        Some(stop),
        false,
    )
    .await
}

/// Close a claimed Native execution when the provider never produced a
/// validated Turn receipt but the owned process cleanup is proven. This is a
/// failure terminal, never a successful provider projection: it releases the
/// Run/Generation hold, seals the primary span as partial, and leaves the
/// assistant side absent so recovery cannot retry an ambiguous effect.
pub async fn finalize_failed(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    cleanup: &CleanupReceipt,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        None,
        ProviderCleanup::Codex(cleanup),
        None,
        true,
    )
    .await
}

/// Hermes counterpart of [`finalize_failed`].
pub async fn finalize_hermes_failed(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    cleanup: &HermesCleanupReceipt,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        None,
        ProviderCleanup::Hermes(cleanup),
        None,
        true,
    )
    .await
}

/// Resolve an unsubmitted Hermes Stop only from the exact owned host cleanup.
pub async fn finalize_hermes_stopped_before_submission(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    cleanup: &HermesCleanupReceipt,
    stop: &super::stopping::StopIntent,
) -> Result<Value> {
    finalize_inner(
        pool,
        actor,
        fence,
        None,
        ProviderCleanup::Hermes(cleanup),
        Some(stop),
        false,
    )
    .await
}

#[derive(Clone, Copy)]
enum ProviderTurn<'a> {
    Codex(&'a TurnReceipt),
    Hermes(&'a HermesTurnReceipt),
    HermesPromptError(&'a HermesPromptErrorAfterCancel),
    Pi(&'a PiTurnReceipt),
    Native(&'a NativeProviderTurnReceipt),
}

#[derive(Clone, Copy)]
enum ProviderCleanup<'a> {
    Codex(&'a CleanupReceipt),
    Hermes(&'a HermesCleanupReceipt),
    Pi(&'a PiCleanupReceipt),
    Host(&'a HostCleanupProof),
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum TerminalStatus {
    Completed,
    Failed,
    Interrupted,
}

impl<'a> ProviderTurn<'a> {
    fn status(self) -> TerminalStatus {
        match self {
            Self::Codex(turn) => match turn.status() {
                TurnStatus::Completed => TerminalStatus::Completed,
                TurnStatus::Failed => TerminalStatus::Failed,
                TurnStatus::Interrupted => TerminalStatus::Interrupted,
            },
            Self::Hermes(turn) => match turn.stop_reason() {
                HermesStopReason::EndTurn | HermesStopReason::Refusal => TerminalStatus::Completed,
                HermesStopReason::Cancelled => TerminalStatus::Interrupted,
                HermesStopReason::ApprovalRequired => TerminalStatus::Failed,
            },
            Self::HermesPromptError(_) => TerminalStatus::Failed,
            Self::Pi(turn) => match turn.status() {
                PiTurnStatus::Completed => TerminalStatus::Completed,
                PiTurnStatus::Failed => TerminalStatus::Failed,
                PiTurnStatus::Interrupted => TerminalStatus::Interrupted,
            },
            Self::Native(turn) => match turn.status {
                NativeProviderStatus::Completed => TerminalStatus::Completed,
                NativeProviderStatus::Failed => TerminalStatus::Failed,
                NativeProviderStatus::Interrupted => TerminalStatus::Interrupted,
            },
        }
    }

    fn final_text(self) -> Option<&'a str> {
        match self {
            Self::Codex(turn) => turn.final_text(),
            Self::Hermes(turn) => Some(turn.final_text()),
            Self::HermesPromptError(_) => None,
            Self::Pi(turn) => turn.final_text(),
            Self::Native(turn) => turn.final_text.as_deref(),
        }
    }

    fn provider_status(self) -> &'static str {
        match self {
            Self::Codex(turn) => match turn.status() {
                TurnStatus::Completed => "completed",
                TurnStatus::Failed => "failed",
                TurnStatus::Interrupted => "interrupted",
            },
            Self::Hermes(turn) => match turn.stop_reason() {
                HermesStopReason::EndTurn => "end_turn",
                HermesStopReason::Cancelled => "cancelled",
                HermesStopReason::Refusal => "refusal",
                HermesStopReason::ApprovalRequired => "approval_required",
            },
            Self::HermesPromptError(_) => "error_response",
            Self::Pi(turn) => match turn.status() {
                PiTurnStatus::Completed => "completed",
                PiTurnStatus::Failed => "failed",
                PiTurnStatus::Interrupted => "interrupted",
            },
            Self::Native(turn) => match turn.status {
                NativeProviderStatus::Completed => "completed",
                NativeProviderStatus::Failed => "failed",
                NativeProviderStatus::Interrupted => "interrupted",
            },
        }
    }

    fn usage_json(self) -> Option<Value> {
        match self {
            Self::Codex(turn) => turn.usage().map(|usage| json!({
                "source":"thread/tokenUsage/updated.tokenUsage.last", "scope":"latest_reported_increment",
                "inputTokens":usage.input_tokens(), "cachedInputTokens":usage.cached_input_tokens(),
                "outputTokens":usage.output_tokens(), "reasoningOutputTokens":usage.reasoning_output_tokens(),
                "totalTokens":usage.total_tokens(),
            })),
            // Hermes reports session-cumulative usage. Do not mislabel it as a
            // per-Run increment or use it to release a billed-cost hold.
            Self::Hermes(_) | Self::HermesPromptError(_) => None,
            Self::Pi(_) => None,
            Self::Native(turn) => turn.usage.clone().map(|usage| json!({
                "source":"provider_terminal_receipt",
                "scope":"provider_reported",
                "usage":usage,
            })),
        }
    }

    fn retry_predicate(self) -> ProviderRetryPredicate<'a> {
        match self {
            Self::Codex(turn) => ProviderRetryPredicate::Codex {
                thread_id: turn.thread_id(),
                turn_id: turn.turn_id(),
            },
            Self::Hermes(turn) => ProviderRetryPredicate::Hermes {
                session_id: turn.session().as_str(),
                request_id: turn.request_id(),
            },
            Self::HermesPromptError(error) => ProviderRetryPredicate::Hermes {
                session_id: error.session().as_str(),
                request_id: error.request_id(),
            },
            Self::Pi(turn) => ProviderRetryPredicate::Pi {
                session_id: turn.session_id(),
                entry_id: turn.input_entry_id(),
            },
            Self::Native(turn) => ProviderRetryPredicate::Native {
                provider: turn.provider,
                session_id: &turn.session_id,
                request_id: &turn.request_id,
            },
        }
    }

    fn checkpoint_matches(self, checkpoint: &NativeChatProtocolCheckpoint) -> bool {
        match self {
            Self::Codex(turn) => {
                checkpoint.thread_id() == Some(turn.thread_id())
                    && checkpoint.turn_id() == Some(turn.turn_id())
            }
            Self::Hermes(turn) => {
                checkpoint.provider()
                    == rudder_runtime_core::native_chat::NativeChatProvider::HermesLocal
                    && checkpoint.hermes_session().map(|session| session.as_str())
                        == Some(turn.session().as_str())
                    && checkpoint.hermes_prompt_request_id() == Some(turn.request_id())
            }
            Self::HermesPromptError(error) => {
                checkpoint.provider()
                    == rudder_runtime_core::native_chat::NativeChatProvider::HermesLocal
                    && checkpoint.hermes_session().map(|session| session.as_str())
                        == Some(error.session().as_str())
                    && checkpoint.hermes_prompt_request_id() == Some(error.request_id())
            }
            Self::Pi(turn) => {
                checkpoint.provider()
                    == rudder_runtime_core::native_chat::NativeChatProvider::PiLocal
                    && checkpoint
                        .pi_session()
                        .is_some_and(|session| session.session_id == turn.session_id())
                    && checkpoint.pi_turn_entry_id() == Some(turn.input_entry_id())
            }
            Self::Native(turn) => {
                let expected =
                    match turn.provider {
                        NativeProviderKind::Claude => {
                            checkpoint.provider()
                                == rudder_runtime_core::native_chat::NativeChatProvider::ClaudeLocal
                                && checkpoint.claude_session().map(|s| s.as_str())
                                    == Some(turn.session_id.as_str())
                                && checkpoint.claude_prompt_request_id()
                                    == Some(turn.request_id.as_str())
                        }
                        NativeProviderKind::Cursor => {
                            checkpoint.provider()
                                == rudder_runtime_core::native_chat::NativeChatProvider::CursorLocal
                                && checkpoint.cursor_session().map(|s| s.as_str())
                                    == Some(turn.session_id.as_str())
                                && checkpoint.cursor_prompt_request_id()
                                    == Some(turn.request_id.as_str())
                        }
                        NativeProviderKind::OpenCode => checkpoint.provider()
                            == rudder_runtime_core::native_chat::NativeChatProvider::OpenCodeLocal
                            && checkpoint.opencode_session().map(|s| s.as_str())
                                == Some(turn.session_id.as_str())
                            && checkpoint.opencode_prompt_request_id()
                                == Some(turn.request_id.as_str()),
                    };
                // The current Claude/Cursor executor may return a terminal
                // receipt from a combined session+prompt call. Before the
                // provider-specific checkpoint fields are persisted, accept
                // only the exact admitted provider phase and let finalization
                // write the session/request identity atomically.
                expected
                    || matches!(
                        checkpoint.phase(),
                        NativeChatProtocolPhase::NoThreadRequest
                            | NativeChatProtocolPhase::ThreadKnown
                    ) && matches!(
                        turn.provider,
                        NativeProviderKind::Claude
                            | NativeProviderKind::Cursor
                            | NativeProviderKind::OpenCode
                    ) && checkpoint.provider()
                        == match turn.provider {
                            NativeProviderKind::Claude => {
                                rudder_runtime_core::native_chat::NativeChatProvider::ClaudeLocal
                            }
                            NativeProviderKind::Cursor => {
                                rudder_runtime_core::native_chat::NativeChatProvider::CursorLocal
                            }
                            NativeProviderKind::OpenCode => {
                                rudder_runtime_core::native_chat::NativeChatProvider::OpenCodeLocal
                            }
                        }
                        && checkpoint.thread_id().is_none()
            }
        }
    }

    fn selector(self) -> Value {
        match self {
            Self::Codex(turn) => {
                json!({"kind":"codex_turn","threadId":turn.thread_id(),"turnId":turn.turn_id()})
            }
            Self::Hermes(turn) => {
                json!({"kind":"hermes_acp_prompt","sessionDigest":hash(turn.session().as_str()),"requestId":turn.request_id()})
            }
            Self::HermesPromptError(error) => {
                json!({"kind":"hermes_acp_prompt_error", "sessionDigest":hash(error.session().as_str()), "requestId":error.request_id(), "errorCode":error.error_code(), "cancelSent":true, "providerCancelAcknowledged":false})
            }
            Self::Pi(turn) => {
                json!({"kind":"pi_turn","sessionDigest":hash(turn.session_id()),"sessionFileDigest":hash(turn.session_file()),"inputEntryId":turn.input_entry_id(),"assistantEntryId":turn.assistant_entry_id(),"leafId":turn.leaf_id()})
            }
            Self::Native(turn) => {
                json!({"kind":match turn.provider { NativeProviderKind::Claude => "claude_turn", NativeProviderKind::Cursor => "cursor_turn", NativeProviderKind::OpenCode => "opencode_turn" },"sessionId":turn.session_id,"requestId":turn.request_id,"evidence":turn.evidence})
            }
        }
    }

    fn native_execution_ref(self) -> Option<String> {
        match self {
            Self::Codex(turn) => Some(turn.turn_id().to_owned()),
            Self::Hermes(turn) => Some(format!("hermes-acp-request:{}", turn.request_id())),
            Self::HermesPromptError(error) => {
                Some(format!("hermes-acp-request:{}", error.request_id()))
            }
            Self::Pi(turn) => Some(format!("pi-leaf:{}", turn.leaf_id())),
            Self::Native(turn) => Some(format!(
                "{}:{}",
                turn.provider.runtime_type(),
                turn.request_id
            )),
        }
    }

    fn input_correlation_ref(self) -> Option<String> {
        match self {
            Self::Codex(_) => None,
            Self::Hermes(turn) => Some(turn.user_message_id().to_owned()),
            Self::HermesPromptError(error) => Some(error.user_message_id().to_owned()),
            Self::Pi(turn) => Some(turn.input_entry_id().to_owned()),
            Self::Native(turn) => Some(turn.request_id.clone()),
        }
    }

    fn evidence_facts(self) -> Value {
        match self {
            Self::Codex(turn) => {
                json!({"provider":"codex_local","threadId":turn.thread_id(),"turnId":turn.turn_id()})
            }
            Self::Hermes(turn) => {
                json!({"provider":"hermes_local","sessionId":turn.session().as_str(),"requestId":turn.request_id(),
                "userMessageId":turn.user_message_id(),"inputFingerprint":turn.input_fingerprint(),
                "providerStatus":self.provider_status(),"finalTextDigest":hash(turn.final_text())})
            }
            Self::HermesPromptError(error) => {
                json!({"provider":"hermes_local", "sessionId":error.session().as_str(), "requestId":error.request_id(), "userMessageId":error.user_message_id(), "inputFingerprint":error.input_fingerprint(), "providerStatus":"error_response", "errorCode":error.error_code(), "cancelSent":true, "providerCancelAcknowledged":false, "usageAvailable":false})
            }
            Self::Pi(turn) => {
                json!({"provider":"pi_local","sessionId":turn.session_id(),"sessionFileDigest":hash(turn.session_file()),"inputEntryId":turn.input_entry_id(),"assistantEntryId":turn.assistant_entry_id(),"leafId":turn.leaf_id(),"inputFingerprint":turn.input_fingerprint(),"providerStatus":self.provider_status(),"finalTextDigest":turn.final_text().map(hash)})
            }
            Self::Native(turn) => {
                json!({"provider":turn.provider.runtime_type(),"sessionId":turn.session_id,"requestId":turn.request_id,"providerStatus":self.provider_status(),"finalTextDigest":turn.final_text.as_deref().map(hash),"evidence":turn.evidence})
            }
        }
    }
}

impl<'a> ProviderCleanup<'a> {
    fn matches_claim(self, fence: &ExecutionFence) -> bool {
        match self {
            Self::Codex(cleanup) => fence.matches_cleanup_receipt(cleanup),
            Self::Hermes(cleanup) => fence.matches_hermes_cleanup_receipt(cleanup),
            Self::Pi(cleanup) => fence.matches_pi_cleanup_receipt(cleanup),
            Self::Host(cleanup) => fence.matches_host_cleanup_proof(cleanup),
        }
    }

    fn proves_turn(self, turn: ProviderTurn<'_>) -> bool {
        match (self, turn) {
            (Self::Codex(cleanup), ProviderTurn::Codex(turn)) => {
                cleanup.proves_quiescence_for(turn)
            }
            (Self::Hermes(cleanup), ProviderTurn::Hermes(turn)) => {
                cleanup.proves_quiescence_for(turn)
            }
            (Self::Hermes(cleanup), ProviderTurn::HermesPromptError(error)) => {
                cleanup.proves_quiescence_for_prompt_error(error)
            }
            (Self::Pi(cleanup), ProviderTurn::Pi(turn)) => cleanup.proves_quiescence_for(turn),
            // `matches_claim` above already binds HostCleanupProof to the
            // exact fence. The host lifecycle proof is provider independent.
            (Self::Host(_), ProviderTurn::Native(_)) => true,
            _ => false,
        }
    }

    fn evidence_fingerprint(self) -> String {
        match self {
            Self::Codex(cleanup) => cleanup.evidence_fingerprint(),
            Self::Hermes(cleanup) => cleanup.evidence_fingerprint(),
            Self::Pi(cleanup) => cleanup.evidence_fingerprint(),
            Self::Host(cleanup) => format!(
                "host:{}:{}",
                cleanup.connection_receipt_id(),
                cleanup.connection_epoch().unwrap_or_default()
            ),
        }
    }
}

enum ProviderRetryPredicate<'a> {
    Codex {
        thread_id: &'a str,
        turn_id: &'a str,
    },
    Hermes {
        session_id: &'a str,
        request_id: u64,
    },
    Pi {
        session_id: &'a str,
        entry_id: &'a str,
    },
    Native {
        provider: NativeProviderKind,
        session_id: &'a str,
        request_id: &'a str,
    },
}

async fn finalize_inner(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    turn: Option<ProviderTurn<'_>>,
    cleanup: ProviderCleanup<'_>,
    stop: Option<&super::stopping::StopIntent>,
    forced_failure: bool,
) -> Result<Value> {
    let id = fence.identity();
    if actor.organization_id() != id.organization_id {
        return Err(http(403, "Organization access denied"));
    }
    let cleanup_matches = cleanup.matches_claim(fence);
    let turn_matches = turn.is_none_or(|turn| {
        cleanup.proves_turn(turn)
            && match turn {
                ProviderTurn::Codex(turn) => turn.matches_execution(
                    id.run_id,
                    id.attempt_id,
                    fence.run_execution_owner_token(),
                ),
                ProviderTurn::Hermes(turn) => turn.matches_execution(
                    id.run_id,
                    id.attempt_id,
                    fence.run_execution_owner_token(),
                ),
                ProviderTurn::HermesPromptError(error) => error.matches_execution(
                    id.run_id,
                    id.attempt_id,
                    fence.run_execution_owner_token(),
                ),
                ProviderTurn::Pi(turn) => turn.matches_execution(
                    id.run_id,
                    id.attempt_id,
                    fence.run_execution_owner_token(),
                ),
                ProviderTurn::Native(turn) => {
                    fence.runtime_type() == turn.provider.runtime_type()
                        || (turn.provider == NativeProviderKind::Cursor
                            && fence.runtime_type() == "cursor")
                }
            }
    });
    if matches!(turn, Some(ProviderTurn::HermesPromptError(_)))
        && (stop.is_none() || forced_failure)
    {
        return Err(http(
            409,
            "Hermes prompt error requires an exact operator Stop",
        ));
    }
    let pre_submission_stop = stop.is_some() && turn.is_none();
    if !cleanup_matches || !turn_matches || (turn.is_none() && stop.is_none() && !forced_failure) {
        return Err(http(
            409,
            "Native Chat receipts belong to another execution",
        ));
    }
    let unprojectable = turn.is_some_and(|turn| {
        stop.is_none()
            && turn.status() == TerminalStatus::Completed
            && turn.final_text().is_none_or(|text| text.trim().is_empty())
    });
    let (run_status, generation_status) = if forced_failure {
        ("failed", "failed")
    } else if stop.is_some() {
        ("cancelled", "stopped")
    } else {
        let turn =
            turn.ok_or_else(|| http(409, "Provider finalization requires a Turn receipt"))?;
        match turn.status() {
            TerminalStatus::Completed if unprojectable => ("failed", "failed"),
            TerminalStatus::Completed => ("succeeded", "completed"),
            TerminalStatus::Failed => ("failed", "failed"),
            TerminalStatus::Interrupted => ("cancelled", "stopped"),
        }
    };
    if turn.is_some_and(|turn| {
        matches!(turn, ProviderTurn::Hermes(value) if value.stop_reason() == HermesStopReason::ApprovalRequired)
    }) {
        return Err(http(409, "Hermes requires a governed approval decision"));
    }
    let increment = turn.and_then(ProviderTurn::usage_json);
    let cost = json!({
        "status":"unknown",
        "reason":if pre_submission_stop { "input_not_submitted_cost_not_established" } else { "provider_cost_not_reported" },
    });
    // Bind retries to every authority dimension and every projected fact. Owner
    // capabilities are hashed into one fingerprint, never returned or logged.
    let mut facts = json!({
        "version":1, "organizationId":id.organization_id, "conversationId":id.conversation_id,
        "generationId":id.generation_id, "runId":id.run_id, "attemptId":id.attempt_id,
        "agentId":id.agent_id, "bindingId":fence.binding_id, "segmentId":fence.segment_id,
        "generationEpoch":id.generation_attempt_epoch, "attemptEpoch":id.run_attempt_epoch,
        "connectionEpoch":id.connection_epoch, "generationOwner":fence.generation_control_owner_token(),
        "runOwner":fence.run_execution_owner_token(),
        "providerEvidence":turn.map(ProviderTurn::evidence_facts),
        "status":run_status, "answer":turn.and_then(ProviderTurn::final_text),
        "usage":increment, "selectedModel":fence.selected_model,
        "cost":cost, "cleanupReceipt":cleanup.evidence_fingerprint(),
    });
    if let Some(stop) = stop {
        facts["stopActionId"] = json!(stop.action_id);
        if let Some(turn) = turn {
            facts["actualProviderStatus"] = json!(turn.provider_status());
        } else {
            facts["inputDisposition"] = json!("not_submitted");
        }
    }
    let fingerprint = hash(&facts.to_string());
    let stop_action_id = stop.map(|value| value.action_id.as_str());
    let mut tx = pool.begin().await?;
    super::super::budget::lock_policy_state(&mut tx, id.organization_id).await?;
    runtime_bindings::preauthorize_chat_execution_target_read_tx(
        &mut tx,
        actor,
        id.organization_id,
        id.conversation_id,
        id.agent_id,
        fence,
    )
    .await?;
    runtime_bindings::lock_native_chat_target_tx(&mut tx, id.organization_id, id.conversation_id)
        .await?;
    runtime_bindings::authorize_chat_execution_target_read_locked_tx(
        &mut tx,
        actor,
        id.organization_id,
        id.conversation_id,
        id.agent_id,
        fence,
    )
    .await?;
    // Read-only retry under the same target serialization. A completed execution
    // has no live lease; it cannot pass the first-finalization owner checks.
    let existing: Option<Value> = if pre_submission_stop {
        sqlx::query_scalar(
            "SELECT r.result_json->'nativeChatFinalization' FROM heartbeat_runs r
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$7::uuid
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
               AND r.chat_conversation_id=$3::uuid AND r.chat_generation_id=$4::uuid
               AND r.execution_owner_token=$5 AND g.control_owner_token=$6 AND a.owner_token=$5
               AND g.attempt_epoch=$8 AND a.generation_attempt_epoch=$8 AND a.attempt_epoch=$9
               AND a.connection_epoch=$10 AND a.protocol_phase='execution_terminal_committed'
               AND a.provider_turn_id IS NULL
               AND r.result_json->'nativeChatFinalization'->>'controlActionId'=$11
               AND EXISTS (
                 SELECT 1 FROM chat_control_actions c
                 WHERE c.org_id=$1::uuid AND c.id::text=$11
                   AND c.expected_generation_id=$4::uuid
                   AND c.local_disposition='stopped'
                   AND c.provider_evidence->'stopResolution'->>'inputDisposition'='not_submitted'
               )",
        )
        .bind(id.organization_id)
        .bind(id.run_id)
        .bind(id.conversation_id)
        .bind(id.generation_id)
        .bind(fence.run_execution_owner_token())
        .bind(fence.generation_control_owner_token())
        .bind(id.attempt_id)
        .bind(id.generation_attempt_epoch)
        .bind(id.run_attempt_epoch)
        .bind(id.connection_epoch)
        .bind(
            stop_action_id
                .ok_or_else(|| http(409, "Pre-submission finalization requires a Stop action"))?,
        )
        .fetch_optional(&mut *tx)
        .await?
        .flatten()
    } else if forced_failure {
        None
    } else {
        let turn = turn.ok_or_else(|| http(409, "Provider retry requires a Turn receipt"))?;
        match turn.retry_predicate() {
            ProviderRetryPredicate::Codex { thread_id, turn_id } => {
                sqlx::query_scalar(
                    "SELECT r.result_json->'nativeChatFinalization' FROM heartbeat_runs r
                     JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
                     JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$7::uuid
                     WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
                       AND r.chat_conversation_id=$3::uuid AND r.chat_generation_id=$4::uuid
                       AND r.execution_owner_token=$5 AND g.control_owner_token=$6 AND a.owner_token=$5
                       AND g.attempt_epoch=$8 AND a.generation_attempt_epoch=$8 AND a.attempt_epoch=$9
                       AND a.connection_epoch=$10 AND a.protocol_phase='execution_terminal_committed'
                       AND a.provider_thread_id=$11 AND a.provider_turn_id=$12",
                )
                .bind(id.organization_id).bind(id.run_id).bind(id.conversation_id).bind(id.generation_id)
                .bind(fence.run_execution_owner_token()).bind(fence.generation_control_owner_token())
                .bind(id.attempt_id).bind(id.generation_attempt_epoch).bind(id.run_attempt_epoch)
                .bind(id.connection_epoch).bind(thread_id).bind(turn_id)
                .fetch_optional(&mut *tx).await?.flatten()
            }
            ProviderRetryPredicate::Hermes { session_id, request_id } => {
                sqlx::query_scalar(
                    "SELECT r.result_json->'nativeChatFinalization' FROM heartbeat_runs r
                     JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
                     JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$7::uuid
                     WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
                       AND r.chat_conversation_id=$3::uuid AND r.chat_generation_id=$4::uuid
                       AND r.execution_owner_token=$5 AND g.control_owner_token=$6 AND a.owner_token=$5
                       AND g.attempt_epoch=$8 AND a.generation_attempt_epoch=$8 AND a.attempt_epoch=$9
                       AND a.connection_epoch=$10 AND a.protocol_phase='execution_terminal_committed'
                       AND a.provider_thread_id IS NULL AND a.provider_turn_id IS NULL
                       AND a.checkpoint_json->>'provider'='hermes_local'
                       AND a.checkpoint_json->>'hermesSession'=$11
                       AND a.checkpoint_json->>'hermesPromptRequestId'=$12",
                )
                .bind(id.organization_id).bind(id.run_id).bind(id.conversation_id).bind(id.generation_id)
                .bind(fence.run_execution_owner_token()).bind(fence.generation_control_owner_token())
                .bind(id.attempt_id).bind(id.generation_attempt_epoch).bind(id.run_attempt_epoch)
                .bind(id.connection_epoch).bind(session_id).bind(request_id.to_string())
                .fetch_optional(&mut *tx).await?.flatten()
            }
            ProviderRetryPredicate::Pi { session_id, entry_id } => {
                sqlx::query_scalar(
                    "SELECT r.result_json->'nativeChatFinalization' FROM heartbeat_runs r
                     JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
                     JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$7::uuid
                     WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
                       AND r.chat_conversation_id=$3::uuid AND r.chat_generation_id=$4::uuid
                       AND r.execution_owner_token=$5 AND g.control_owner_token=$6 AND a.owner_token=$5
                       AND g.attempt_epoch=$8 AND a.generation_attempt_epoch=$8 AND a.attempt_epoch=$9
                       AND a.connection_epoch=$10 AND a.protocol_phase='execution_terminal_committed'
                       AND a.provider_thread_id IS NULL AND a.provider_turn_id IS NULL
                       AND a.checkpoint_json->>'provider'='pi_local'
                       AND a.checkpoint_json->'piSession'->>'sessionId'=$11
                       AND a.checkpoint_json->>'piTurnEntryId'=$12",
                )
                .bind(id.organization_id).bind(id.run_id).bind(id.conversation_id).bind(id.generation_id)
                .bind(fence.run_execution_owner_token()).bind(fence.generation_control_owner_token())
                .bind(id.attempt_id).bind(id.generation_attempt_epoch).bind(id.run_attempt_epoch)
                .bind(id.connection_epoch).bind(session_id).bind(entry_id)
                .fetch_optional(&mut *tx).await?.flatten()
            }
            ProviderRetryPredicate::Native {
                provider,
                session_id,
                request_id,
            } => {
                let provider_name = provider.checkpoint_provider();
                let session_key = match provider {
                    NativeProviderKind::Claude => "claudeSession",
                    NativeProviderKind::Cursor => "cursorSession",
                    NativeProviderKind::OpenCode => "opencodeSession",
                };
                let request_key = match provider {
                    NativeProviderKind::Claude => "claudePromptRequestId",
                    NativeProviderKind::Cursor => "cursorPromptRequestId",
                    NativeProviderKind::OpenCode => "opencodePromptRequestId",
                };
                let query = format!(
                    "SELECT r.result_json->'nativeChatFinalization' FROM heartbeat_runs r
                     JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
                     JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$7::uuid
                     WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
                       AND r.chat_conversation_id=$3::uuid AND r.chat_generation_id=$4::uuid
                       AND r.execution_owner_token=$5 AND g.control_owner_token=$6 AND a.owner_token=$5
                       AND g.attempt_epoch=$8 AND a.generation_attempt_epoch=$8 AND a.attempt_epoch=$9
                       AND a.connection_epoch=$10 AND a.protocol_phase='execution_terminal_committed'
                       AND a.provider_thread_id IS NULL AND a.provider_turn_id IS NULL
                       AND a.checkpoint_json->>'provider'=$11
                       AND a.checkpoint_json->>'{session_key}'=$12
                       AND a.checkpoint_json->>'{request_key}'=$13"
                );
                sqlx::query_scalar(&query)
                    .bind(id.organization_id)
                    .bind(id.run_id)
                    .bind(id.conversation_id)
                    .bind(id.generation_id)
                    .bind(fence.run_execution_owner_token())
                    .bind(fence.generation_control_owner_token())
                    .bind(id.attempt_id)
                    .bind(id.generation_attempt_epoch)
                    .bind(id.run_attempt_epoch)
                    .bind(id.connection_epoch)
                    .bind(provider_name)
                    .bind(session_id)
                    .bind(request_id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .flatten()
            }
        }
    };
    if let Some(existing) = existing {
        if existing["fingerprint"].as_str() != Some(fingerprint.as_str()) {
            return Err(http(
                409,
                "Native Chat finalization evidence conflicts with its committed result",
            ));
        }
        let result = existing["result"].clone();
        if !result.is_object() {
            return Err(http(409, "Native Chat finalization receipt is invalid"));
        }
        tx.commit().await?;
        return Ok(result);
    }
    let locked = if let Some(stop) = stop {
        super::context::lock_stopping_execution(&mut tx, actor, fence, stop).await?
    } else {
        lock_current_execution(&mut tx, actor, fence).await?
    };
    let checkpoint_matches = if forced_failure {
        locked.checkpoint.phase() != NativeChatProtocolPhase::ExecutionTerminalCommitted
    } else if pre_submission_stop {
        matches!(
            locked.checkpoint.phase(),
            NativeChatProtocolPhase::NoThreadRequest
                | NativeChatProtocolPhase::ThreadKnown
                | NativeChatProtocolPhase::InputPreSubmission
        ) && locked.checkpoint.turn_id().is_none()
    } else if let Some(turn) = turn {
        // Claude/Cursor currently return a typed terminal receipt from a
        // combined session+prompt adapter call. Their provider-native session
        // and request IDs are therefore first observed at this boundary, so
        // the admitted pre-effect phases are accepted once and the finalizer
        // atomically records those IDs below. Codex/Hermes/Pi still require
        // their explicit terminal-observed transition (or a governed Stop
        // from TurnKnown).
        let native_combined_phase = matches!(turn, ProviderTurn::Native(_))
            && matches!(
                locked.checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest | NativeChatProtocolPhase::ThreadKnown
            );
        (locked.checkpoint.phase() == NativeChatProtocolPhase::ProviderTerminalObserved
            || (stop.is_some() && locked.checkpoint.phase() == NativeChatProtocolPhase::TurnKnown)
            || (stop.is_some()
                && matches!(turn, ProviderTurn::HermesPromptError(_))
                && locked.checkpoint.phase() == NativeChatProtocolPhase::InputIndeterminate)
            || native_combined_phase)
            && turn.checkpoint_matches(&locked.checkpoint)
    } else {
        false
    };
    if !checkpoint_matches {
        return Err(http(
            409,
            "Native Chat terminal does not match the durable checkpoint",
        ));
    }
    if let Some(ProviderTurn::HermesPromptError(error)) = turn
        && (locked.admitted_message_id.as_deref() != Some(error.user_message_id())
            || locked.admitted_input_fingerprint.as_deref() != Some(error.input_fingerprint()))
    {
        return Err(http(
            409,
            "Hermes prompt error does not match the admitted input",
        ));
    }
    if pre_submission_stop {
        let stop = stop.ok_or_else(|| http(409, "Pre-submission finalization requires Stop"))?;
        super::stopping::require_empty_frozen_prefix(&mut tx, fence, stop).await?;
    }
    let budget_held =
        super::super::budget::has_unsettleable_policy(&mut tx, id.organization_id, id.agent_id)
            .await?;
    let held = budget_held || unprojectable;
    let (chat_turn_id, turn_variant, model) = if pre_submission_stop || forced_failure {
        (None, 0, None)
    } else {
        let source = sqlx::query(
            "SELECT m.chat_turn_id::text AS chat_turn_id,m.turn_variant,a.model
             FROM chat_generations g JOIN chat_messages m ON m.org_id=g.org_id AND m.id=g.source_message_id
             JOIN heartbeat_run_attempts a ON a.org_id=g.org_id AND a.id=$3::uuid
             WHERE g.org_id=$1::uuid AND g.id=$2::uuid FOR UPDATE OF m",
        ).bind(id.organization_id).bind(id.generation_id).bind(id.attempt_id)
            .fetch_one(&mut *tx).await?;
        (
            source.try_get::<Option<String>, _>("chat_turn_id")?,
            source.try_get::<i32, _>("turn_variant")?,
            source.try_get::<Option<String>, _>("model")?,
        )
    };
    let increment = increment.map(|mut value| {
        value["attemptId"] = json!(id.attempt_id);
        value["modelSource"] = json!(model.as_ref().map(|_| "execution_config"));
        value["model"] = json!(model);
        value
    });
    // Codex `last` is the latest model-response increment, not a complete
    // user-turn total. Preserve it as observation without feeding Run counters.
    let usage = if pre_submission_stop {
        json!({"status":"unavailable", "reason":"input_not_submitted"})
    } else {
        json!({"status":"unavailable", "reason":"run_total_not_established",
            "latestReportedIncrement":increment})
    };
    let mut checkpoint = serde_json::to_value(&locked.checkpoint)
        .map_err(|_| http(500, "Cannot encode Native Chat checkpoint"))?;
    if let Some(ProviderTurn::Native(turn)) = turn {
        checkpoint["provider"] = json!(turn.provider.checkpoint_provider());
        match turn.provider {
            NativeProviderKind::Claude => {
                checkpoint["claudeSession"] = json!(turn.session_id);
                checkpoint["claudePromptRequestId"] = json!(turn.request_id);
            }
            NativeProviderKind::Cursor => {
                checkpoint["cursorSession"] = json!(turn.session_id);
                checkpoint["cursorPromptRequestId"] = json!(turn.request_id);
            }
            NativeProviderKind::OpenCode => {
                checkpoint["opencodeSession"] = json!(turn.session_id);
                checkpoint["opencodePromptRequestId"] = json!(turn.request_id);
            }
        }
    }
    checkpoint["phase"] = json!("execution_terminal_committed");
    checkpoint["revision"] = json!(
        locked
            .checkpoint
            .revision()
            .checked_add(1)
            .ok_or_else(|| http(409, "Native Chat checkpoint revision exhausted"))?
    );
    let validated: NativeChatProtocolCheckpoint = serde_json::from_value(checkpoint.clone())
        .map_err(|_| http(409, "Native Chat terminal checkpoint is invalid"))?;
    validated
        .validate()
        .map_err(|_| http(409, "Native Chat terminal checkpoint is invalid"))?;
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:finalize',true)")
        .execute(&mut *tx)
        .await?;

    // Combined provider adapters may observe their session while sending the
    // first prompt. Persist that provider-native locator before terminal state
    // so replay and later sends share one immutable Segment identity.
    if let Some(ProviderTurn::Native(turn)) = turn {
        if !matches!(
            fence.runtime_type(),
            "claude_local" | "cursor" | "cursor_local" | "opencode_local"
        ) || (fence.runtime_type() == "claude_local"
            && turn.provider != NativeProviderKind::Claude)
            || (matches!(fence.runtime_type(), "cursor" | "cursor_local")
                && turn.provider != NativeProviderKind::Cursor)
            || (fence.runtime_type() == "opencode_local"
                && turn.provider != NativeProviderKind::OpenCode)
        {
            return Err(http(
                409,
                "Native provider runtime identity does not match receipt",
            ));
        }
        if let Some(stored) = locked.native_session_id.as_deref() {
            if stored != turn.session_id {
                return Err(http(
                    409,
                    "Native provider session changed before finalization",
                ));
            }
        } else {
            let updated = sqlx::query(
                "UPDATE native_segments
                 SET native_session_id=$4,state='open',updated_at=clock_timestamp()
                 WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid
                   AND state='pending' AND native_session_id IS NULL AND sealed_at IS NULL",
            )
            .bind(id.organization_id)
            .bind(&fence.binding_id)
            .bind(&fence.segment_id)
            .bind(&turn.session_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if updated != 1 {
                return Err(http(
                    409,
                    "Native provider Segment changed before finalization",
                ));
            }
        }
    }

    let message_id: Option<String> = if forced_failure {
        None
    } else if let Some(stop) = stop {
        super::stopping::frozen_message(&mut tx, fence, stop).await?
    } else {
        let final_text = turn.and_then(ProviderTurn::final_text);
        let existing = sqlx::query(
            "SELECT id::text,status,kind,replying_agent_id::text AS replying_agent_id,
              chat_turn_id::text AS chat_turn_id,turn_variant,
              CASE WHEN octet_length(body)<=$4 THEN body END AS body,
              (structured_payload IS NULL OR structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS plain
             FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
              AND run_id=$3::uuid AND role='assistant'
             ORDER BY id LIMIT 2 FOR UPDATE",
        )
        .bind(id.organization_id)
        .bind(id.conversation_id)
        .bind(id.run_id)
        .bind(MAX_PROJECTED_BODY_BYTES)
        .fetch_all(&mut *tx)
        .await?;
        if existing.len() > 1 {
            return Err(http(409, "Native Chat assistant projection is ambiguous"));
        }
        if let Some(message) = existing.first() {
            let message_id: String = message.try_get("id")?;
            let body: String = message
                .try_get::<Option<String>, _>("body")?
                .ok_or_else(|| http(409, "Native Chat assistant projection exceeds its bound"))?;
            if message.try_get::<String, _>("status")? != "streaming"
                || message.try_get::<String, _>("kind")? != "message"
                || message
                    .try_get::<Option<String>, _>("replying_agent_id")?
                    .as_deref()
                    != Some(id.agent_id)
                || message
                    .try_get::<Option<String>, _>("chat_turn_id")?
                    .as_deref()
                    != chat_turn_id.as_deref()
                || message.try_get::<i32, _>("turn_variant")? != turn_variant
                || !message.try_get::<bool, _>("plain")?
                || (matches!(
                    (turn, cleanup),
                    (Some(ProviderTurn::Hermes(_)), ProviderCleanup::Hermes(_))
                ) && !body.is_empty())
                || (!matches!(
                    (turn, cleanup),
                    (Some(ProviderTurn::Hermes(_)), ProviderCleanup::Hermes(_))
                ) && final_text.is_some_and(|text| text != body.as_str()))
            {
                return Err(http(409, "Native Chat assistant projection changed"));
            }
            match (turn, cleanup) {
                (Some(ProviderTurn::Codex(_)), ProviderCleanup::Codex(cleanup)) => {
                    output::validate_final_projection(&mut tx, fence, cleanup, &message_id, &body)
                        .await?;
                }
                (Some(ProviderTurn::Hermes(_)), ProviderCleanup::Hermes(_)) => {}
                (Some(ProviderTurn::Pi(_)), _) => {
                    return Err(http(409, "Pi live output projection is unsupported"));
                }
                (Some(ProviderTurn::Native(_)), ProviderCleanup::Host(_)) => {}
                _ => return Err(http(409, "Native Chat projection receipt is invalid")),
            }
            let status = match run_status {
                "succeeded" => "completed",
                "cancelled" => "stopped",
                _ => "failed",
            };
            let updated = sqlx::query(
                "UPDATE chat_messages SET body=COALESCE($5,body),status=$4,updated_at=clock_timestamp()
                 WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid
                   AND role='assistant' AND status='streaming'",
            )
            .bind(id.organization_id)
            .bind(id.conversation_id)
            .bind(&message_id)
            .bind(status)
            .bind(match (turn, cleanup, stop) {
                (
                    Some(ProviderTurn::Hermes(turn)),
                    ProviderCleanup::Hermes(_),
                    None,
                ) => Some(turn.final_text()),
                _ => None,
            })
            .execute(&mut *tx)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(http(409, "Native Chat assistant projection changed"));
            }
            Some(message_id)
        } else if let Some(text) = final_text.filter(|text| !text.trim().is_empty()) {
            Some(
                sqlx::query_scalar(
                    "INSERT INTO chat_messages (org_id,conversation_id,role,kind,status,body,run_id,
                 replying_agent_id,chat_turn_id,turn_variant)
                 VALUES ($1::uuid,$2::uuid,'assistant','message',$3,$4,$5::uuid,$6::uuid,$7::uuid,$8)
                 RETURNING id::text",
                )
                .bind(id.organization_id)
                .bind(id.conversation_id)
                .bind(match run_status {
                    "succeeded" => "completed",
                    "cancelled" => "stopped",
                    _ => "failed",
                })
                .bind(text)
                .bind(id.run_id)
                .bind(id.agent_id)
                .bind(chat_turn_id.as_deref())
                .bind(turn_variant)
                .fetch_one(&mut *tx)
                .await?,
            )
        } else {
            None
        }
    };
    // Both a frozen Stop projection and a newly inserted final answer must
    // validate the same owned progress ledger. Keep this outside the ordinary
    // streaming-row branch so neither path can bypass receipt validation.
    if let (Some(receipt), ProviderCleanup::Hermes(cleanup), Some(message_id)) =
        (turn, cleanup, message_id.as_deref())
        && matches!(
            receipt,
            ProviderTurn::Hermes(_) | ProviderTurn::HermesPromptError(_)
        )
    {
        validate_hermes_progress_for_terminal(&mut tx, fence, receipt, cleanup, message_id,
            stop.is_none() && matches!(receipt, ProviderTurn::Hermes(value)
                if value.stop_reason() == HermesStopReason::EndTurn && !value.final_text().trim().is_empty())).await?;
    }
    if message_id.is_none()
        && matches!(
            turn,
            Some(ProviderTurn::Hermes(_) | ProviderTurn::HermesPromptError(_))
        )
    {
        let orphaned_progress: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid AND run_id=$3::uuid AND event_kind='transcript')")
            .bind(id.organization_id).bind(id.generation_id).bind(id.run_id).fetch_one(&mut *tx).await?;
        if orphaned_progress {
            return Err(http(409, "Hermes progress lost its assistant projection"));
        }
    }
    let (span_completeness, native_execution_ref, input_correlation_ref, selector) = match turn {
        Some(turn) => (
            "terminal_only",
            turn.native_execution_ref(),
            turn.input_correlation_ref()
                .or(locked.admitted_message_id.clone()),
            turn.selector(),
        ),
        None if forced_failure => (
            "partial",
            None,
            None,
            json!({"kind":"native_execution_failure","inputDisposition":"unknown"}),
        ),
        None => (
            "partial",
            None,
            None,
            json!({"kind":"native_pre_submission_stop","inputDisposition":"not_submitted"}),
        ),
    };
    let span_id: String = sqlx::query_scalar(
        "UPDATE run_runtime_spans SET state='sealed',completeness=$8,
         native_execution_ref=$9,input_correlation_ref=$10,selector_json=$11,
         closed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND attempt_id=$3::uuid
           AND binding_id=$4::uuid AND segment_id=$5::uuid AND owner_token=$6
           AND attempt_epoch=$7 AND relation='primary' AND state='open' AND closed_at IS NULL
         RETURNING id::text",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .bind(id.attempt_id)
    .bind(&fence.binding_id)
    .bind(&fence.segment_id)
    .bind(fence.run_execution_owner_token())
    .bind(id.run_attempt_epoch)
    .bind(span_completeness)
    .bind(native_execution_ref)
    .bind(input_correlation_ref)
    .bind(selector)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat primary span is not open for this owner"))?;
    // All slow writes above remain reversible. Recheck both leases immediately
    // before committing terminal state; every mutation rolls back on expiry.
    if let Some(stop) = stop {
        super::context::lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    } else {
        lock_current_execution(&mut tx, actor, fence).await?;
    }
    let mut result = json!({"runId":id.run_id,"generationId":id.generation_id,"attemptId":id.attempt_id,
        "assistantMessageId":message_id,"spanId":span_id,"status":run_status,
        "generationStatus":generation_status,
        "cost":cost,"usage":usage,"nativeAdmissionHold":held,
        "projectionDisposition":if forced_failure { "failed_without_terminal_receipt" } else if stop.is_some() { "frozen_at_stop" } else if unprojectable { "unsupported_final_answer" } else { "projected" },
        "budgetDisposition":if budget_held { "reconciliation_required" } else { "unbudgeted_unknown_cost" }});
    if let Some(ProviderTurn::HermesPromptError(error)) = turn {
        result["providerStatus"] = json!("error_response");
        result["providerErrorCode"] = json!(error.error_code());
        result["cancelSent"] = json!(true);
        result["providerCancelAcknowledged"] = json!(false);
        result["usageAvailable"] = json!(false);
    }
    if pre_submission_stop {
        result["inputDisposition"] = json!("not_submitted");
    }
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET status=$4,finished_at=clock_timestamp(),
         protocol_phase='execution_terminal_committed',checkpoint_json=$5,
         usage_delta_json=$6,cost_cents=NULL WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    ).bind(id.organization_id).bind(id.run_id).bind(id.attempt_id).bind(run_status)
        .bind(checkpoint).bind(&usage).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE heartbeat_runs SET status=$3,finished_at=clock_timestamp(),process_exited_at=clock_timestamp(),
         running_substate=NULL,usage_json=$4,result_json=$5,native_admission_hold=$6,
         updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    ).bind(id.organization_id).bind(id.run_id).bind(run_status).bind(&usage)
        .bind(json!({"nativeChatFinalization":{"version":1,"fingerprint":fingerprint,
            "controlActionId":stop.map(|value| value.action_id.as_str()),"result":result}})).bind(held)
        .execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE chat_generations SET status=$3,terminal_reason=$4,control_state='terminal',
         runtime_terminal_at=clock_timestamp(),completed_at=clock_timestamp(),
         native_admission_hold=$5,updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid",
    ).bind(id.organization_id).bind(id.generation_id).bind(generation_status)
        .bind(if stop.is_some() {
            "operator_stop".to_owned()
        } else if unprojectable {
            "native_provider_completed_without_projectable_answer".to_owned()
        } else {
            format!("native_provider_{run_status}")
        }).bind(held).execute(&mut *tx).await?;
    if let Some(stop) = stop {
        if pre_submission_stop {
            match cleanup {
                ProviderCleanup::Codex(cleanup) => {
                    super::stopping::resolve_action_pre_submission(
                        &mut tx, actor, fence, stop, cleanup, &result,
                    )
                    .await?;
                }
                ProviderCleanup::Hermes(cleanup) => {
                    super::stopping::resolve_action_hermes_pre_submission(
                        &mut tx, actor, fence, stop, cleanup, &result,
                    )
                    .await?;
                }
                ProviderCleanup::Pi(_) => {
                    return Err(http(409, "Pi Stop finalization is unsupported"));
                }
                ProviderCleanup::Host(_) => {
                    return Err(http(
                        409,
                        "Native provider pre-submission Stop finalization is unsupported",
                    ));
                }
            }
        } else {
            let Some(turn) = turn else {
                return Err(http(
                    409,
                    "Provider Stop finalization requires a Turn receipt",
                ));
            };
            match (turn, cleanup) {
                (ProviderTurn::Codex(turn), ProviderCleanup::Codex(cleanup)) => {
                    super::stopping::resolve_action(
                        &mut tx, actor, fence, stop, turn, cleanup, &result,
                    )
                    .await?;
                }
                (ProviderTurn::Hermes(turn), ProviderCleanup::Hermes(cleanup)) => {
                    super::stopping::resolve_action_hermes(
                        &mut tx, actor, fence, stop, turn, cleanup, &result,
                    )
                    .await?;
                }
                (ProviderTurn::HermesPromptError(error), ProviderCleanup::Hermes(cleanup)) => {
                    super::stopping::resolve_action_hermes_prompt_error(
                        &mut tx, actor, fence, stop, error, cleanup, &result,
                    )
                    .await?;
                }
                (ProviderTurn::Pi(_), ProviderCleanup::Pi(_)) => {
                    return Err(http(409, "Pi Stop finalization is unsupported"));
                }
                (ProviderTurn::Native(_), ProviderCleanup::Host(_)) => {
                    return Err(http(
                        409,
                        "Native provider Stop finalization is unsupported",
                    ));
                }
                _ => return Err(http(409, "Provider Stop evidence does not match")),
            }
        }
    }
    for event in ["runtime_terminal", "terminal_projected"] {
        sqlx::query(
            "INSERT INTO chat_generation_events (org_id,generation_id,generation_seq,attempt_epoch,
             event_kind,payload,assistant_message_id,run_id,control_action_id)
             SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid
             FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid",
        )
        .bind(id.organization_id)
        .bind(id.generation_id)
        .bind(id.generation_attempt_epoch)
        .bind(event)
        .bind(&result)
        .bind(message_id.as_deref())
        .bind(id.run_id)
        .bind(stop.map(|s|s.action_id.as_str()))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO heartbeat_run_events (org_id,run_id,agent_id,seq,event_type,payload,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(seq),0)+1,'status',$4,$5
         FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid",
    ).bind(id.organization_id).bind(id.run_id).bind(id.agent_id).bind(&result)
        .bind(format!("native-finalize:{}",id.attempt_id)).execute(&mut *tx).await?;
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(id.run_id.into()),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: id.organization_id,
            audit: &audit,
            action: "runtime.native_chat.finalized",
            entity_type: "heartbeat_run",
            entity_id: id.run_id,
            details: Some(&result),
            options: ActivityOptions {
                agent_id: Some(id.agent_id),
                bind_run: true,
                ..Default::default()
            },
        },
    )
    .await?;
    // Row locks retain both owners through commit. Even an event/activity
    // write that waited must not commit after the original owner lease expired.
    let leases_live: bool = sqlx::query_scalar(
        "SELECT COALESCE(g.control_lease_expires_at > clock_timestamp(),false)
          AND COALESCE(r.execution_lease_expires_at > clock_timestamp(),false)
         FROM chat_generations g JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid
           AND g.control_owner_token=$4 AND r.execution_owner_token=$5",
    ).bind(id.organization_id).bind(id.generation_id).bind(id.run_id)
        .bind(fence.generation_control_owner_token()).bind(fence.run_execution_owner_token())
        .fetch_optional(&mut *tx).await?.unwrap_or(false);
    if !leases_live {
        return Err(http(409, "Native Chat lease expired during finalization"));
    }
    sqlx::query("UPDATE chat_generations SET control_lease_expires_at=NULL WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id).bind(id.generation_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=NULL WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id).bind(id.run_id).execute(&mut *tx).await?;
    super::super::auth::authorize_execution_org(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(result)
}

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> NativeProviderTurnReceipt {
        NativeProviderTurnReceipt {
            provider: NativeProviderKind::Claude,
            session_id: "claude-session".to_owned(),
            request_id: "result-1".to_owned(),
            final_text: Some("answer".to_owned()),
            status: NativeProviderStatus::Completed,
            usage: Some(json!({"inputTokens": 1, "outputTokens": 2})),
            evidence: json!({"resultUuid": "result-1"}),
        }
    }

    #[test]
    fn native_provider_identity_never_uses_codex_fields() {
        assert_eq!(NativeProviderKind::Claude.runtime_type(), "claude_local");
        assert_eq!(NativeProviderKind::Cursor.runtime_type(), "cursor_local");
        assert_eq!(
            NativeProviderKind::OpenCode.runtime_type(),
            "opencode_local"
        );
        assert_eq!(
            NativeProviderKind::Claude.checkpoint_provider(),
            "claude_local"
        );
        assert_eq!(
            NativeProviderKind::Cursor.checkpoint_provider(),
            "cursor_local"
        );
        assert_eq!(
            NativeProviderKind::OpenCode.checkpoint_provider(),
            "open_code_local"
        );
    }

    #[test]
    fn native_receipt_bounds_are_checked_before_database_work() {
        assert!(validate_native_receipt(&receipt()).is_ok());

        let mut empty = receipt();
        empty.request_id.clear();
        assert!(validate_native_receipt(&empty).is_err());

        let mut oversized = receipt();
        oversized.final_text = Some("x".repeat(MAX_PROJECTED_BODY_BYTES as usize + 1));
        assert!(validate_native_receipt(&oversized).is_err());
    }
}
