//! One bounded Claude Code execution path for persisted Goal wakeups.
//!
//! Goal prompt construction and Agent JWT signing stay in Foundation's
//! trusted context bridge. This module accepts only that prepared text/env,
//! an already materialized D1 claim, and the config resolved from persisted
//! Agent/Goal state. It owns the provider process through matching cleanup.

use crate::{HostPaths, claude, claude::ClaudeExecutionError};
use rudder_claude_code::ClaudeTurnStatus;
use rudder_d1_persistence::{
    goal_runs::{self, GoalRunClaim, GoalRunError},
    native_chat::config::ResolvedCodexConfig,
};
use rudder_native_process_transport::HostCleanupProof;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::runtime::Handle;

const OWNER_LEASE: Duration = Duration::from_secs(30);
const OWNER_RENEW_INTERVAL: Duration = Duration::from_secs(10);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(500);
const CLEANUP_LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(5);
const DATABASE_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalRunExecutionState {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Unresolved,
}

/// Provider evidence returned to the server-foundation owner. A `cleanup_proof`
/// exists only when Claude's exact process-host connection produced the
/// matching terminal cleanup receipt. Callers must keep the Run unresolved
/// when this field is absent after a child may have launched.
pub struct GoalRunExecutionObservation {
    pub state: GoalRunExecutionState,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub usage: Value,
    pub result: Value,
    pub cleanup_proof: Option<HostCleanupProof>,
}

#[derive(Debug, thiserror::Error)]
pub enum GoalRunExecutorError {
    #[error("Goal Claude worker ended before returning its owned claim")]
    WorkerInterrupted,
}

/// Execute the already prepared Goal prompt through the one supported native
/// provider path. The returned claim remains available for D1 finalization.
/// No prompt is accepted from an HTTP request; Foundation builds it from the
/// claimed wakeup and the current trusted runtime context.
pub async fn execute_goal_claude_run(
    pool: PgPool,
    claim: GoalRunClaim,
    config: ResolvedCodexConfig,
    paths: HostPaths,
    prompt: String,
    extra_env: BTreeMap<String, String>,
    instruction_context_sections: Vec<String>,
    shutdown: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<(GoalRunClaim, GoalRunExecutionObservation), GoalRunExecutorError> {
    if config.identity.runtime_type != "claude_local"
        || config.claude.is_none()
        || timeout.is_zero()
        || timeout > Duration::from_secs(3600)
        || extra_env.keys().any(|key| key != "RUDDER_API_KEY")
    {
        return Ok((
            claim,
            unresolved(
                "claude_invalid_configuration",
                "Goal Claude runtime configuration is unavailable",
            ),
        ));
    }

    if shutdown.load(Ordering::Acquire) {
        return Ok((
            claim,
            GoalRunExecutionObservation {
                state: GoalRunExecutionState::Cancelled,
                error_code: Some("cancelled".into()),
                error: Some("Goal Run was cancelled before Claude launched".into()),
                usage: Value::Null,
                result: Value::Null,
                cleanup_proof: None,
            },
        ));
    }

    match goal_runs::cancellation_requested(&pool, &claim).await {
        Ok(true) => {
            return Ok((
                claim,
                GoalRunExecutionObservation {
                    state: GoalRunExecutionState::Cancelled,
                    error_code: Some("cancelled".into()),
                    error: Some("Goal Run was cancelled before Claude launched".into()),
                    usage: Value::Null,
                    result: Value::Null,
                    cleanup_proof: None,
                },
            ));
        }
        Ok(false) => {}
        Err(error) => {
            return Ok((
                claim,
                unresolved("goal_run_persistence", &error.to_string()),
            ));
        }
    }
    match goal_runs::renew_lease(&pool, &claim, OWNER_LEASE).await {
        Ok(true) => {}
        Ok(false) => {
            return Ok((
                claim,
                unresolved(
                    "goal_run_ownership_lost",
                    "Goal Run lease was lost before Claude launched",
                ),
            ));
        }
        Err(error) => {
            return Ok((
                claim,
                unresolved("goal_run_persistence", &error.to_string()),
            ));
        }
    }

    let handle = Handle::current();
    let worker_pool = pool.clone();
    let worker_claim = claim;
    let worker_shutdown = shutdown;
    let result = tokio::task::spawn_blocking(move || {
        execute_goal_claude_blocking(
            &handle,
            &worker_pool,
            worker_claim,
            &config,
            &paths,
            &prompt,
            &extra_env,
            &instruction_context_sections,
            &worker_shutdown,
            timeout,
        )
    })
    .await;
    match result {
        Ok((claim, result)) => Ok((claim, result)),
        Err(_) => Err(GoalRunExecutorError::WorkerInterrupted),
    }
}

fn execute_goal_claude_blocking(
    handle: &Handle,
    pool: &PgPool,
    mut claim: GoalRunClaim,
    config: &ResolvedCodexConfig,
    paths: &HostPaths,
    prompt: &str,
    extra_env: &BTreeMap<String, String>,
    instruction_context_sections: &[String],
    shutdown: &AtomicBool,
    timeout: Duration,
) -> (GoalRunClaim, GoalRunExecutionObservation) {
    let Some(local) = config.claude.as_ref() else {
        return (
            claim,
            unresolved(
                "claude_invalid_configuration",
                "Goal Agent has no resolved Claude configuration",
            ),
        );
    };
    let Some(permit) = claim.take_connection_launch_permit() else {
        return (
            claim,
            unresolved(
                "goal_run_ownership_lost",
                "Goal Run has no available process-host launch capability",
            ),
        );
    };

    let mut last_owner_renewal = Instant::now();
    let mut last_cancel_poll = Instant::now();
    let mut last_cleanup_renewal = Instant::now();
    let mut cleanup_started = false;
    let mut stop_requested = false;

    let result = claude::execute_turn(
        handle,
        config,
        local,
        paths,
        permit,
        &claim.run_id,
        &claim.attempt_id,
        &claim.owner_token,
        None,
        extra_env,
        instruction_context_sections,
        true,
        |transport| {
            let process_id = transport
                .process_id()
                .ok_or(ClaudeExecutionError::InvalidConfiguration)?;
            let recorded = bounded_database_call(
                handle,
                goal_runs::record_process_started(pool, &claim, process_id),
            )?;
            if recorded {
                Ok(())
            } else {
                Err(ClaudeExecutionError::GoalRunOwnershipLost)
            }
        },
        |transport| {
            transport
                .send_user_message(prompt)
                .map_err(ClaudeExecutionError::from)
        },
        |transport, terminal_observed, cleanup_deadline| {
            let now = Instant::now();
            if let Some(cleanup_deadline) = cleanup_deadline {
                cleanup_started = true;
                if now.duration_since(last_cleanup_renewal) >= CLEANUP_LEASE_RENEW_INTERVAL {
                    if now + DATABASE_OPERATION_TIMEOUT < cleanup_deadline {
                        let renewed = bounded_database_call(
                            handle,
                            goal_runs::renew_cleanup_lease(pool, &claim, OWNER_LEASE),
                        )?;
                        last_cleanup_renewal = Instant::now();
                        if !renewed {
                            return Err(ClaudeExecutionError::GoalRunOwnershipLost);
                        }
                    }
                }
                return Ok(false);
            }

            if !terminal_observed && shutdown.load(Ordering::Acquire) && !stop_requested {
                let _ = transport.send_interrupt();
                transport
                    .stop(STOP_GRACE.as_millis() as u64)
                    .map_err(ClaudeExecutionError::from)?;
                stop_requested = true;
                return Ok(true);
            }
            if !terminal_observed && now.duration_since(last_cancel_poll) >= CANCEL_POLL_INTERVAL {
                let cancelled =
                    bounded_database_call(handle, goal_runs::cancellation_requested(pool, &claim))?;
                last_cancel_poll = Instant::now();
                if cancelled && !stop_requested {
                    // Ask Claude to stop cooperatively, then stop its owned
                    // process group within the bounded host grace period.
                    let _ = transport.send_interrupt();
                    transport
                        .stop(STOP_GRACE.as_millis() as u64)
                        .map_err(ClaudeExecutionError::from)?;
                    stop_requested = true;
                    return Ok(true);
                }
            }
            if !terminal_observed
                && !cleanup_started
                && now.duration_since(last_owner_renewal) >= OWNER_RENEW_INTERVAL
            {
                let renewed = bounded_database_call(
                    handle,
                    goal_runs::renew_lease(pool, &claim, OWNER_LEASE),
                )?;
                last_owner_renewal = Instant::now();
                if !renewed {
                    let _ = transport.stop(STOP_GRACE.as_millis() as u64);
                    return Err(ClaudeExecutionError::GoalRunOwnershipLost);
                }
            }
            Ok(false)
        },
        timeout,
    );

    match result {
        Ok(observation) => {
            let usage = claude_usage_payload(
                observation.turn.usage(),
                observation.turn.total_cost_usd_micros(),
                config.model.as_deref(),
                local.env.contains_key("ANTHROPIC_API_KEY"),
            );
            let result_json = json!({
                "provider": "anthropic",
                "biller": "anthropic",
                "model": config.model.as_deref().unwrap_or("unknown"),
                "sessionId": observation.session.as_str(),
                "sessionParamsAfter": {
                    "sessionId": observation.session.as_str(),
                    "cwd": config.cwd.to_string_lossy(),
                },
                "resultUuid": observation.turn.result_uuid(),
                "subtype": observation.turn.subtype(),
                "status": match observation.turn.status() {
                    ClaudeTurnStatus::Completed => "succeeded",
                    ClaudeTurnStatus::Failed => "failed",
                },
                "isError": observation.turn.is_error(),
                "summary": observation.turn.summary(),
                "totalCostUsdMicros": observation.turn.total_cost_usd_micros(),
                "usage": observation.turn.usage(),
            });
            let state = match observation.turn.status() {
                ClaudeTurnStatus::Completed => GoalRunExecutionState::Succeeded,
                ClaudeTurnStatus::Failed => GoalRunExecutionState::Failed,
            };
            (
                claim,
                GoalRunExecutionObservation {
                    state,
                    error_code: None,
                    error: observation
                        .turn
                        .summary()
                        .filter(|_| observation.turn.is_error())
                        .map(str::to_owned),
                    usage,
                    result: result_json,
                    cleanup_proof: observation.cleanup,
                },
            )
        }
        Err(failure) => {
            let error_code = failure.error.diagnostic_code().to_owned();
            let state = if matches!(&failure.error, ClaudeExecutionError::Timeout) {
                GoalRunExecutionState::TimedOut
            } else {
                GoalRunExecutionState::Failed
            };
            let result = json!({
                "provider": "anthropic",
                "model": config.model.as_deref().unwrap_or("unknown"),
                "errorCode": error_code,
                "error": failure.error.to_string(),
            });
            (
                claim,
                GoalRunExecutionObservation {
                    state: if failure.cleanup.is_some() {
                        state
                    } else {
                        GoalRunExecutionState::Unresolved
                    },
                    error_code: Some(error_code),
                    error: Some(failure.error.to_string()),
                    usage: Value::Null,
                    result,
                    cleanup_proof: failure.cleanup.map(|proof| *proof),
                },
            )
        }
    }
}

fn bounded_database_call<T>(
    handle: &Handle,
    future: impl Future<Output = Result<T, GoalRunError>>,
) -> Result<T, ClaudeExecutionError> {
    handle
        .block_on(tokio::time::timeout(DATABASE_OPERATION_TIMEOUT, future))
        .map_err(|_| ClaudeExecutionError::GoalRunOwnershipLost)?
        .map_err(ClaudeExecutionError::from)
}

fn claude_usage_payload(
    raw_usage: Option<&Value>,
    cost_micros: Option<u64>,
    model: Option<&str>,
    metered_api: bool,
) -> Value {
    let Some(raw) = raw_usage else {
        return Value::Null;
    };
    let read = raw
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let creation = raw
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cached_input_tokens = read.saturating_add(creation).min(i64::MAX as u64) as i64;
    let input_tokens = raw
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .min(i64::MAX as u64) as i64;
    let output_tokens = raw
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .min(i64::MAX as u64) as i64;
    let billing_type = if metered_api {
        "metered_api"
    } else {
        "subscription_included"
    };
    let mut usage = json!({
        "inputTokens": input_tokens,
        "cachedInputTokens": cached_input_tokens,
        "outputTokens": output_tokens,
        "rawInputTokens": input_tokens,
        "rawCachedInputTokens": cached_input_tokens,
        "rawOutputTokens": output_tokens,
        "rawUsage": raw,
        "provider": "anthropic",
        "biller": "anthropic",
        "model": model.unwrap_or("unknown"),
        "billingType": billing_type,
    });
    let Some(object) = usage.as_object_mut() else {
        return Value::Null;
    };
    if let Some(cost_micros) = cost_micros {
        object.insert("costUsd".into(), json!(cost_micros as f64 / 1_000_000.0));
    }
    usage
}

fn unresolved(error_code: &str, error: &str) -> GoalRunExecutionObservation {
    GoalRunExecutionObservation {
        state: GoalRunExecutionState::Unresolved,
        error_code: Some(error_code.to_owned()),
        error: Some(error.to_owned()),
        usage: Value::Null,
        result: Value::Null,
        cleanup_proof: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{GoalRunExecutionState, claude_usage_payload, unresolved};
    use serde_json::{Value, json};

    #[test]
    fn claude_goal_usage_keeps_normalized_tokens_raw_source_and_metering() {
        let raw = json!({
            "input_tokens": 120,
            "cache_read_input_tokens": 30,
            "cache_creation_input_tokens": 5,
            "output_tokens": 17
        });
        let usage = claude_usage_payload(Some(&raw), Some(1_250_000), Some("claude-4"), true);
        assert_eq!(usage["inputTokens"], 120);
        assert_eq!(usage["cachedInputTokens"], 35);
        assert_eq!(usage["outputTokens"], 17);
        assert_eq!(usage["rawInputTokens"], 120);
        assert_eq!(usage["rawCachedInputTokens"], 35);
        assert_eq!(usage["rawOutputTokens"], 17);
        assert_eq!(usage["provider"], "anthropic");
        assert_eq!(usage["biller"], "anthropic");
        assert_eq!(usage["model"], "claude-4");
        assert_eq!(usage["billingType"], "metered_api");
        assert_eq!(usage["costUsd"], 1.25);
        assert_eq!(usage["rawUsage"], raw);
    }

    #[test]
    fn subscription_usage_is_labeled_without_inventing_cost() {
        let raw = json!({"input_tokens": 1, "output_tokens": 2});
        let usage = claude_usage_payload(Some(&raw), None, None, false);
        assert_eq!(usage["billingType"], "subscription_included");
        assert_eq!(usage["model"], "unknown");
        assert!(usage.get("costUsd").is_none());
    }

    #[test]
    fn prelaunch_observation_is_unresolved_without_cleanup_evidence() {
        let result = unresolved("goal_run_persistence", "write failed");
        assert_eq!(result.state, GoalRunExecutionState::Unresolved);
        assert!(result.cleanup_proof.is_none());
        assert_eq!(result.usage, Value::Null);
    }
}
