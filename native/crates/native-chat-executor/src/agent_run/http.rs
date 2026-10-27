use super::{
    AgentRunExecutionObservation, AgentRunExecutionState, AgentRunRequest, config, projection,
};
use rudder_d1_persistence::agent_execution::{AgentRunClaim, lifecycle};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{sync::atomic::Ordering, time::Duration};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Entire request lifecycle, including response-body reads and cancellation,
/// is awaited by OwnedRequestExecution::settle. A body stalled after successful
/// headers is still an active request until this future cancels/returns.
pub(super) async fn execute(
    pool: &PgPool,
    claim: &AgentRunClaim,
    request: &AgentRunRequest,
) -> AgentRunExecutionObservation {
    let mut pending = Box::pin(invoke(claim, request));
    let started = tokio::time::Instant::now();
    let timeout = if claim.runtime_type == "http" {
        config::duration(&request.config, "timeoutMs", 0.0).map(|value| value / 1000)
    } else {
        config::duration(&request.config, "timeoutSec", 120.0)
    };
    let mut renewal = tokio::time::Instant::now();
    let mut cancellation_poll = tokio::time::Instant::now();
    let gateway = claim.runtime_type != "http";
    let mut stop_reason = None;
    loop {
        if request.cancelled.load(Ordering::Acquire) {
            if !gateway {
                return AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Cancelled,
                    "cancelled",
                    "Agent runtime request cancelled",
                );
            }
            stop_reason.get_or_insert(AgentRunExecutionState::Cancelled);
        }
        if timeout.is_some_and(|timeout| started.elapsed() >= timeout) {
            if !gateway {
                return AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::TimedOut,
                    "timeout",
                    "Agent runtime request timed out",
                );
            }
            stop_reason.get_or_insert(AgentRunExecutionState::TimedOut);
            request.cancelled.store(true, Ordering::Release);
        }
        match tokio::time::timeout(Duration::from_millis(100), pending.as_mut()).await {
            Ok(mut observation) => {
                if let Some(reason) = stop_reason {
                    observation.state = reason;
                    observation.error_code = Some(
                        if reason == AgentRunExecutionState::TimedOut {
                            "timeout"
                        } else {
                            "cancelled"
                        }
                        .into(),
                    );
                    if observation.error.is_none() {
                        observation.error = Some("Agent Gateway execution stopped".into());
                    }
                }
                return observation;
            }
            Err(_) => (),
        }
        if cancellation_poll.elapsed() >= Duration::from_millis(500) {
            cancellation_poll = tokio::time::Instant::now();
            match tokio::time::timeout(
                Duration::from_secs(5),
                lifecycle::cancellation_requested(pool, &claim.owned),
            )
            .await
            {
                Ok(Ok(false)) => (),
                Ok(Ok(true)) => {
                    if !gateway {
                        return AgentRunExecutionObservation::failure(
                            AgentRunExecutionState::Cancelled,
                            "cancelled",
                            "Agent runtime request cancellation requested",
                        );
                    }
                    stop_reason.get_or_insert(AgentRunExecutionState::Cancelled);
                    request.cancelled.store(true, Ordering::Release);
                }
                _ => {
                    if !gateway {
                        return AgentRunExecutionObservation::failure(
                            AgentRunExecutionState::Unresolved,
                            "agent_run_ownership_lost",
                            "Agent runtime request cancellation state is unavailable",
                        );
                    }
                    stop_reason = Some(AgentRunExecutionState::Unresolved);
                    request.cancelled.store(true, Ordering::Release);
                }
            }
        }
        if renewal.elapsed() >= Duration::from_secs(10) {
            renewal = tokio::time::Instant::now();
            let renewed = tokio::time::timeout(Duration::from_secs(5), async {
                if stop_reason == Some(AgentRunExecutionState::Cancelled) {
                    lifecycle::renew_cleanup_lease(pool, &claim.owned, Duration::from_secs(30))
                        .await
                } else {
                    lifecycle::renew_lease(pool, &claim.owned, Duration::from_secs(30)).await
                }
            })
            .await;
            if !matches!(renewed, Ok(Ok(true))) {
                if !gateway {
                    return AgentRunExecutionObservation::failure(
                        AgentRunExecutionState::Unresolved,
                        "agent_run_ownership_lost",
                        "Agent runtime request owner lease was lost",
                    );
                }
                stop_reason = Some(AgentRunExecutionState::Unresolved);
                request.cancelled.store(true, Ordering::Release);
            }
        }
    }
}

async fn invoke(claim: &AgentRunClaim, request: &AgentRunRequest) -> AgentRunExecutionObservation {
    if claim.runtime_type != "http" {
        return super::gateway::execute(claim, request).await;
    }
    let config = &request.config;
    let method = match config::string(config, "method", "POST").parse::<reqwest::Method>() {
        Ok(method) => method,
        Err(_) => {
            return AgentRunExecutionObservation::failure(
                AgentRunExecutionState::Failed,
                "invalid_runtime_config",
                "HTTP adapter method is invalid",
            );
        }
    };
    // The existing fetch adapter always supplies the JSON body, and therefore
    // rejects GET/HEAD rather than silently changing the invocation contract.
    if method == reqwest::Method::GET || method == reqwest::Method::HEAD {
        return AgentRunExecutionObservation::failure(
            AgentRunExecutionState::Failed,
            "invalid_runtime_config",
            "HTTP runtime GET/HEAD requests cannot have a request body",
        );
    }
    let Some(url) = config::nonempty(config, "url") else {
        return AgentRunExecutionObservation::failure(
            AgentRunExecutionState::Failed,
            "invalid_runtime_config",
            "HTTP adapter missing url",
        );
    };
    let mut body = config["payloadTemplate"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    body.insert("agentId".into(), json!(claim.agent_id));
    body.insert("runId".into(), json!(claim.run_id));
    body.insert("context".into(), request.context.clone());
    let mut outgoing = reqwest::Client::new().request(method, url).json(&body);
    for (key, value) in config["headers"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            outgoing = outgoing.header(key, value);
        }
    }
    let response = async {
        let mut response = outgoing.send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "HTTP invoke failed with status {}",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err(format!(
                "HTTP runtime response exceeded {MAX_RESPONSE_BYTES} bytes"
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(format!(
                    "HTTP runtime response exceeded {MAX_RESPONSE_BYTES} bytes"
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok::<_, String>(String::from_utf8_lossy(&bytes).into_owned())
    }
    .await;
    match response {
        Err(error) => {
            let mut observation = AgentRunExecutionObservation::failure(
                AgentRunExecutionState::Failed,
                "http_invoke_failed",
                &error,
            );
            if let Some(network) =
                projection::network_suspension(&error, "", "", None, None, false, false)
            {
                observation.state = AgentRunExecutionState::Suspended;
                observation.result = json!({"networkSuspension":network});
            }
            observation
        }
        Ok(raw) => {
            let parsed = serde_json::from_str::<Value>(&raw)
                .ok()
                .filter(Value::is_object);
            let summary = if let Some(parsed) = &parsed {
                ["text", "message", "content", "summary"]
                    .iter()
                    .find_map(|key| {
                        parsed[*key]
                            .as_str()
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                    })
                    .unwrap_or("")
                    .to_owned()
            } else {
                raw.trim().to_owned()
            };
            AgentRunExecutionObservation {
                state: AgentRunExecutionState::Succeeded,
                error_code: None,
                error: None,
                exit_code: Some(0),
                signal: None,
                usage: Value::Null,
                result: json!({"summary":summary,"resultJson":parsed.unwrap_or_else(|| if summary.is_empty() { Value::Null } else { json!({"text":summary}) })}),
                session_id: None,
                session_params: None,
                clear_session: false,
                stdout: raw,
                stderr: String::new(),
                events: Vec::new(),
                cleanup_proof: None,
            }
        }
    }
}
