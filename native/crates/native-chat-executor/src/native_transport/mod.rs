//! Native Chat ownership around the existing Agent transport clients. No
//! Heartbeat claim, queue, Issue, or request-facing actor crosses this boundary.
mod process;
mod request;

use crate::{Error, ExecutionFailure, HostPaths, agent_run};
use agent_run::{
    AgentRunExecutionObservation, AgentRunExecutionState, AgentRunRequest, RuntimeTransportTarget,
};
use rudder_codex_app_server::ConnectionLaunchPermit;
use rudder_d1_persistence::native_chat::{
    NativeChatExecutionPrincipal,
    config::ResolvedCodexConfig,
    execution::{self, ExecutionFence, TransportCleanupProof, TransportTurnReceipt},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};
use tokio::runtime::Handle;

pub struct NativeTransportObservation {
    pub execution_principal: NativeChatExecutionPrincipal,
    pub fence: ExecutionFence,
    pub turn: TransportTurnReceipt,
    pub cleanup: Option<TransportCleanupProof>,
    pub stop: Option<execution::StopIntent>,
    pub terminal_ready: bool,
}

#[allow(clippy::too_many_arguments)] // Existing claim, trusted installation and cancellation boundary.
pub(super) fn run_claimed(
    handle: &Handle,
    pool: &PgPool,
    principal: NativeChatExecutionPrincipal,
    fence: ExecutionFence,
    config: ResolvedCodexConfig,
    permit: ConnectionLaunchPermit,
    cancelled: &AtomicBool,
    deadline: Instant,
    paths: &HostPaths,
) -> Result<NativeTransportObservation, ExecutionFailure> {
    let Some(transport) = config.transport.as_ref() else {
        return Err(ExecutionFailure::before_launch_with_permit(
            Error::UnsupportedConfiguration,
            principal,
            fence,
            permit,
        ));
    };
    let context = match crate::db(
        handle,
        deadline,
        execution::load_transport_chat_context(pool, &principal, &fence),
    ) {
        Ok(context) => context,
        Err(error) => {
            return Err(ExecutionFailure::before_launch_with_permit(
                error, principal, fence, permit,
            ));
        }
    };
    let prompt = match config
        .instruction_content
        .as_deref()
        .filter(|text| !text.trim().is_empty())
    {
        Some(instructions) => format!("{instructions}\n\n{}", context.prompt),
        None => context.prompt,
    };
    let mut context = context.context;
    context["chatPrompt"] = json!(prompt);
    let mut request = AgentRunRequest {
        prompt,
        context,
        config: transport.config.clone(),
        cwd: config.cwd.clone(),
        process_host: paths.process_host.clone(),
        runtime_root: paths.runtime_root.clone(),
        env: transport.env.clone(),
        managed_args: Vec::new(),
        output: None,
        cancelled: Arc::new(AtomicBool::new(
            cancelled.load(std::sync::atomic::Ordering::Acquire),
        )),
    };
    let snapshot = match crate::db(
        handle,
        deadline,
        execution::current_checkpoint(pool, &principal, &fence),
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return Err(ExecutionFailure::before_launch_with_permit(
                error, principal, fence, permit,
            ));
        }
    };
    let target = RuntimeTransportTarget {
        runtime_type: config.identity.runtime_type.clone(),
        run_id: fence.identity().run_id.into(),
        agent_id: fence.identity().agent_id.into(),
        session_id: snapshot.transport_session,
        session_params: None,
    };
    let launch = if matches!(
        target.runtime_type.as_str(),
        "http" | "hermes_gateway" | "openclaw_gateway"
    ) {
        None
    } else {
        match agent_run::resolve_transport_process(
            &target.runtime_type,
            &target.agent_id,
            None,
            target.session_id.as_deref(),
            &request,
        ) {
            Ok(launch) => Some(launch),
            Err(_) => {
                return Err(ExecutionFailure::before_launch_with_permit(
                    Error::UnsupportedConfiguration,
                    principal,
                    fence,
                    permit,
                ));
            }
        }
    };
    let invocation = match crate::db(
        handle,
        deadline,
        execution::prepare_transport_invocation(pool, &principal, &fence, permit),
    ) {
        Ok(invocation) => invocation,
        Err(error) => return Err(ExecutionFailure::before_launch(error, principal, fence)),
    };
    let request_id = invocation.request_id().to_owned();
    let (mut observation, cleanup, mut stop) = if let Some(launch) = launch {
        process::execute(
            handle, pool, &principal, &fence, invocation, &request, launch, cancelled, deadline,
        )
    } else {
        handle.block_on(request::execute(
            pool,
            &principal,
            &fence,
            invocation,
            &target,
            &mut request,
            cancelled,
            deadline,
        ))
    };
    // Only a returned owner can carry cleanup. An interrupted/unresolved owner
    // retains the hold for the existing recovery authority; never replay input.
    if cleanup.as_ref().is_none_or(|proof| !proof.matches(&fence)) {
        return Err(ExecutionFailure::after_claim(
            Error::WorkerInterrupted,
            principal,
            fence,
            None,
        ));
    }
    let settlement_known = terminal_settled(&observation, cleanup.as_ref());
    let recorded = handle.block_on(tokio::time::timeout(
        std::time::Duration::from_secs(5),
        async {
            if stop.is_none() {
                stop = execution::observe_stop(pool, &principal, &fence).await?;
            }
            if !settlement_known {
                return Ok::<_, rudder_d1_persistence::runtime_bindings::Error>(None);
            }
            execution::record_transport_terminal(
                pool,
                &principal,
                &fence,
                &request_id,
                observation.session_id.as_deref(),
                stop.as_ref(),
            )
            .await
            .map(Some)
        },
    ));
    let terminal_ready = settlement_known && matches!(recorded, Ok(Ok(Some(_))));
    let status = match observation.state {
        AgentRunExecutionState::Succeeded => execution::NativeProviderStatus::Completed,
        AgentRunExecutionState::Cancelled => execution::NativeProviderStatus::Interrupted,
        _ => execution::NativeProviderStatus::Failed,
    };
    for secret in &transport.secret_values {
        observation.stdout = observation.stdout.replace(secret, "[REDACTED]");
        observation.stderr = observation.stderr.replace(secret, "[REDACTED]");
        if let Some(error) = &mut observation.error {
            *error = error.replace(secret, "[REDACTED]");
        }
        redact_value(&mut observation.result, secret);
    }
    let final_text = observation.result["summary"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            (!observation.stdout.trim().is_empty()).then(|| observation.stdout.trim().to_owned())
        });
    let mut evidence = json!({"runtimeType":target.runtime_type,"state":format!("{:?}",observation.state),"errorCode":observation.error_code,"error":observation.error,"result":observation.result,"exitCode":observation.exit_code,"signal":observation.signal,"localRequestSettled":matches!(cleanup.as_ref(),Some(TransportCleanupProof::Request(_)))});
    // This observation contains provider results, never invocation env/config.
    if let Some(attachments) = evidence["result"]["generatedAttachments"]
        .as_array()
        .cloned()
    {
        evidence["generatedAttachments"] = Value::Array(attachments);
    }
    let turn = TransportTurnReceipt {
        request_id,
        session_id: observation.session_id.take(),
        final_text,
        status,
        usage: (!observation.usage.is_null()).then_some(observation.usage),
        evidence,
    };
    Ok(NativeTransportObservation {
        execution_principal: principal,
        fence,
        turn,
        cleanup,
        stop,
        terminal_ready,
    })
}

fn terminal_settled(
    observed: &AgentRunExecutionObservation,
    cleanup: Option<&TransportCleanupProof>,
) -> bool {
    if matches!(
        observed.state,
        AgentRunExecutionState::Unresolved | AgentRunExecutionState::Suspended
    ) {
        return false;
    }
    match cleanup {
        Some(TransportCleanupProof::Process(_)) => true,
        Some(TransportCleanupProof::Request(_)) => request_terminal_settled(observed),
        None => false,
    }
}

fn request_terminal_settled(observed: &AgentRunExecutionObservation) -> bool {
    observed.state == AgentRunExecutionState::Succeeded
        || observed.error_code.as_deref() == Some("invalid_runtime_config")
        || observed.result["remoteCancellationVerified"] == true
        || matches!(
            observed.result["requestOutcome"].as_str(),
            Some("provider_terminal" | "response_failed" | "not_sent")
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_settlement_never_promotes_unknown_remote_acceptance_to_a_terminal() {
        for state in [
            AgentRunExecutionState::TimedOut,
            AgentRunExecutionState::Cancelled,
            AgentRunExecutionState::Failed,
            AgentRunExecutionState::Suspended,
        ] {
            let mut observed = failure(state, "transport_error", "connection lost after send");
            assert!(!request_terminal_settled(&observed));
            observed.result = json!({"requestOutcome":"unknown"});
            assert!(!request_terminal_settled(&observed));
            observed.result = json!({"remoteCancellationVerified":true});
            assert!(request_terminal_settled(&observed));
        }
        for outcome in ["not_sent", "response_failed", "provider_terminal"] {
            let mut observed = failure(
                AgentRunExecutionState::Failed,
                "provider_failure",
                "known terminal",
            );
            observed.result = json!({"requestOutcome":outcome});
            assert!(request_terminal_settled(&observed));
        }
    }
}

pub(super) fn failure(
    state: AgentRunExecutionState,
    code: &str,
    error: impl Into<String>,
) -> AgentRunExecutionObservation {
    AgentRunExecutionObservation::failure(state, code, error)
}

fn redact_value(value: &mut Value, secret: &str) {
    match value {
        Value::String(text) => *text = text.replace(secret, "[REDACTED]"),
        Value::Array(items) => {
            for item in items {
                redact_value(item, secret)
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                redact_value(value, secret)
            }
        }
        _ => (),
    }
}
