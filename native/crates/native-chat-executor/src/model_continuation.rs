//! Reuse provider receipt types to ask D1 for a configured next Attempt. This
//! adapter cannot retry an unknown request or mint an execution capability.
use super::*;
use execution::{
    NativeProviderKind, NativeProviderStatus, NativeProviderTurnReceipt, ProviderCleanup,
    ProviderTurn,
};

pub(super) fn next(
    handle: &Handle,
    pool: &PgPool,
    observed: &NativeExecutionObservation,
    host: &LocalHostContext,
    _paths: &HostPaths,
    deadline: Instant,
) -> Option<execution::ClaimedExecution> {
    let invoke = |actor: &NativeChatExecutionPrincipal,
                  fence: &ExecutionFence,
                  turn: ProviderTurn<'_>,
                  cleanup: ProviderCleanup<'_>| {
        db(
            handle,
            deadline,
            execution::continue_after_terminal(pool, actor, fence, turn, cleanup, host, |_| Ok(())),
        )
        .ok()
        .flatten()
    };
    match observed {
        NativeExecutionObservation::Codex(o) if o.stop.is_none() => invoke(
            &o.execution_principal,
            &o.fence,
            ProviderTurn::Codex(&o.turn_receipt),
            ProviderCleanup::Codex(o.cleanup_receipt.as_ref()?),
        ),
        NativeExecutionObservation::Hermes(o) if o.stop.is_none() => invoke(
            &o.execution_principal,
            &o.fence,
            ProviderTurn::Hermes(&o.turn_receipt),
            ProviderCleanup::Hermes(o.cleanup_receipt.as_ref()?),
        ),
        NativeExecutionObservation::Pi(o) if o.stop.is_none() => invoke(
            &o.execution_principal,
            &o.fence,
            ProviderTurn::Pi(o.observation.turn_receipt.as_ref()?),
            ProviderCleanup::Pi(o.observation.cleanup_receipt.as_ref()?),
        ),
        NativeExecutionObservation::Transport(o) if o.stop.is_none() && o.terminal_ready => invoke(
            &o.execution_principal,
            &o.fence,
            ProviderTurn::Transport(&o.turn),
            ProviderCleanup::Transport(o.cleanup.as_ref()?),
        ),
        NativeExecutionObservation::Claude(o) if o.observation.stop.is_none() => {
            let p = &o.observation;
            let cleanup = p.cleanup.as_ref()?;
            let turn = NativeProviderTurnReceipt {
                provider: NativeProviderKind::Claude,
                session_id: p.turn.session_id().as_str().into(),
                request_id: p.turn.result_uuid()?.into(),
                final_text: p.turn.summary().map(str::to_owned),
                status: match p.turn.status() {
                    rudder_claude_code::ClaudeTurnStatus::Completed => {
                        NativeProviderStatus::Completed
                    }
                    rudder_claude_code::ClaudeTurnStatus::Failed => NativeProviderStatus::Failed,
                },
                usage: p.turn.usage().cloned(),
                evidence: json!({"provider":"claude_local","sessionId":p.turn.session_id().as_str(),"resultUuid":p.turn.result_uuid(),"subtype":p.turn.subtype(),"isError":p.turn.is_error()}),
            };
            invoke(
                &o.execution_principal,
                &o.fence,
                ProviderTurn::Native(&turn),
                ProviderCleanup::Host(cleanup),
            )
        }
        NativeExecutionObservation::OpenCode(o) if o.observation.stop.is_none() => {
            let p = &o.observation;
            let turn = match &p.terminal {
                rudder_opencode_native::OpenCodeInputTerminal::Completed(r) => {
                    NativeProviderTurnReceipt {
                        provider: NativeProviderKind::OpenCode,
                        session_id: r.session_id.clone(),
                        request_id: p.request_id.clone(),
                        final_text: (!r.final_text.trim().is_empty())
                            .then_some(r.final_text.clone()),
                        status: NativeProviderStatus::Completed,
                        usage: r.tokens.as_ref().and_then(|v| serde_json::to_value(v).ok()),
                        evidence: json!({"provider":"opencode_local","sessionId":r.session_id,"userMessageId":r.user_message_id,"assistantMessageId":r.assistant_message_id,"cost":r.cost,"cancelAcknowledged":p.cancel_acknowledged}),
                    }
                }
                rudder_opencode_native::OpenCodeInputTerminal::Failed(r) => {
                    NativeProviderTurnReceipt {
                        provider: NativeProviderKind::OpenCode,
                        session_id: r.session_id.clone(),
                        request_id: p.request_id.clone(),
                        final_text: None,
                        status: NativeProviderStatus::Failed,
                        usage: None,
                        evidence: json!({"provider":"opencode_local","sessionId":r.session_id,"userMessageId":r.user_message_id,"assistantMessageId":r.assistant_message_id,"providerErrorObserved":true,"cancelAcknowledged":p.cancel_acknowledged}),
                    }
                }
            };
            invoke(
                &o.execution_principal,
                &o.fence,
                ProviderTurn::Native(&turn),
                ProviderCleanup::Host(&p.cleanup),
            )
        }
        NativeExecutionObservation::Cursor(o) if o.observation.stop.is_none() => {
            let p = &o.observation;
            let final_text = p.final_text.clone().or_else(|| {
                p.response
                    .get("text")
                    .or_else(|| p.response.get("output"))
                    .or_else(|| p.response.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            let turn = NativeProviderTurnReceipt {
                provider: NativeProviderKind::Cursor,
                session_id: p.session.as_str().into(),
                request_id: p.request_id.clone(),
                final_text,
                status: if p.stop_reason == "cancelled" {
                    NativeProviderStatus::Interrupted
                } else {
                    NativeProviderStatus::Completed
                },
                usage: None,
                evidence: json!({"provider":"cursor_local","sessionId":p.session.as_str(),"requestId":p.request_id,"updateCount":p.update_count,"response":p.response}),
            };
            invoke(
                &o.execution_principal,
                &o.fence,
                ProviderTurn::Native(&turn),
                ProviderCleanup::Host(&p.cleanup),
            )
        }
        _ => None,
    }
}

pub(super) fn before_launch(
    handle: &Handle,
    pool: &PgPool,
    failure: &ExecutionFailure,
    host: &LocalHostContext,
    deadline: Instant,
) -> Option<execution::ClaimedExecution> {
    if failure.process_disposition() != ProcessDisposition::NotLaunched
        || !failure.is_definitive_failure()
    {
        return None;
    }
    let actor = failure.execution_principal()?;
    let fence = failure.fence()?;
    let permit = failure.unspent_launch_permit()?;
    db(
        handle,
        deadline,
        execution::continue_before_launch(pool, actor, fence, permit, host),
    )
    .ok()
    .flatten()
}
