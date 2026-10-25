//! Process-owned execution of durable, native GoalStarted wakeups.
//!
//! This worker deliberately supports one closed provider/reason pair until
//! additional adapters and wake contracts are ported. Native-owned rows never
//! fall back to the Node heartbeat consumer.

use crate::{
    goal_run_context::{GoalRunContextInput, build_goal_run_invocation},
    public_ingress_config::{NativeChatPublicRuntime, NativeIdentityAuthConfig},
};
use rudder_d1_persistence::{
    goal_costs,
    goal_run_resources::load_goal_started_resources,
    goal_runs::{self, GoalRunClaim},
};
use rudder_native_chat_executor::{
    GoalRunExecutionObservation, GoalRunExecutionState, execute_goal_claude_run,
};
use rudder_native_process_transport::read_durable_cleanup_receipt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::path::Path;
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{task::JoinHandle, time::sleep};

const POLL_INTERVAL: Duration = Duration::from_millis(500);

fn goal_prompt_context(
    claim: &GoalRunClaim,
    config: &rudder_d1_persistence::native_chat::config::ResolvedCodexConfig,
    claude: &rudder_d1_persistence::native_chat::config::ClaudeLocalConfig,
) -> Option<Value> {
    let organization_workspace_root = claude.organization_workspace_root.as_deref()?;
    let path = |value: &Path| value.to_string_lossy().into_owned();
    let agent_home = path(&claude.agent_home);
    let organization_root = path(organization_workspace_root);
    let cwd = path(&config.cwd);
    let mut context = json!({
        "scene": "heartbeat",
        "rudderScene": "heartbeat",
        "rudderWorkspace": {
            "cwd": cwd.clone(),
            "source": "agent_home",
            "mode": "agent_default",
            "strategy": null,
            "projectId": null,
            "workspaceId": null,
            "repoUrl": null,
            "repoRef": null,
            "branchName": null,
            "worktreePath": null,
            "executionWorkspaceCwd": cwd.clone(),
            "executionWorkspaceSource": "agent_home",
            "agentHome": agent_home.clone(),
            "agentRoot": agent_home.clone(),
            "instructionsDir": Path::new(&agent_home).join("instructions").to_string_lossy().into_owned(),
            "memoryDir": path(&claude.memory_dir),
            "lifeDir": Path::new(&agent_home).join("life").to_string_lossy().into_owned(),
            "agentSkillsDir": Path::new(&agent_home).join("skills").to_string_lossy().into_owned(),
            "orgWorkspaceRoot": organization_root.clone(),
            "orgAgentsDir": Path::new(&organization_root).join("agents").to_string_lossy().into_owned(),
            "orgSkillsDir": Path::new(&organization_root).join("skills").to_string_lossy().into_owned(),
            "projectLibraryRoot": null,
            "projectLibraryRelativePath": null,
            "resourcesPrompt": "",
            "orgResourcesPrompt": ""
        },
        "rudderWorkspaces": [],
        "rudderResources": [],
        "rudderOrganizationResources": [],
        "rudderProjectResources": [],
        "rudderOrgNotes": ""
    });
    if let Some(services) = claim
        .agent_context
        .get("runtimeConfig")
        .and_then(|value| value.get("workspaceRuntime"))
        .and_then(|value| value.get("services"))
        .and_then(Value::as_array)
    {
        let services = services
            .iter()
            .filter(|value| value.is_object())
            .cloned()
            .collect::<Vec<_>>();
        if !services.is_empty() {
            context["rudderRuntimeServiceIntents"] = json!(services);
        }
    }
    Some(context)
}

/// Public-ingress-owned queue loop. Dropping the ingress requests cancellation;
/// its `run` method joins this task before returning.
pub(crate) struct GoalRunWorker {
    shutdown: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}

impl GoalRunWorker {
    pub(crate) fn start(
        pool: PgPool,
        runtime: NativeChatPublicRuntime,
        identity: NativeIdentityAuthConfig,
    ) -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let task_shutdown = Arc::clone(&shutdown);
        let task = tokio::spawn(async move {
            run_queue(pool, runtime, identity, task_shutdown).await;
        });
        Self {
            shutdown,
            task: Some(task),
        }
    }

    pub(crate) async fn shutdown(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(task) = self.task.take()
            && let Err(error) = task.await
        {
            tracing::error!(event = "native_goal_worker_join_failed", error = %error);
        }
    }
}

impl Drop for GoalRunWorker {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
    }
}

async fn run_queue(
    pool: PgPool,
    runtime: NativeChatPublicRuntime,
    identity: NativeIdentityAuthConfig,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::Acquire) {
        let expired_owners = match goal_runs::list_expired_native_goal_runs(&pool).await {
            Ok(expired) => expired,
            Err(error) => {
                tracing::warn!(event = "native_goal_owner_recovery_scan_failed", error = %error);
                Vec::new()
            }
        };
        for expired in expired_owners {
            if shutdown.load(Ordering::Acquire) {
                break;
            }
            match read_durable_cleanup_receipt(
                &runtime.paths.runtime_root,
                &expired.run_id,
                &expired.attempt_id,
                &expired.owner_token,
                expired.connection_epoch,
                &expired.connection_claim_id,
            ) {
                Ok(Some(receipt)) => {
                    match goal_runs::recover_expired_with_cleanup_receipt(&pool, &expired, &receipt)
                        .await
                    {
                        Ok(true) => tracing::warn!(
                            event = "native_goal_owner_recovered_after_cleanup",
                            run_id = %expired.run_id,
                            host_status = receipt.host_status(),
                        ),
                        Ok(false) => {}
                        Err(error) => tracing::error!(
                            event = "native_goal_owner_recovery_failed",
                            run_id = %expired.run_id,
                            error = %error,
                        ),
                    }
                }
                Ok(None) => {
                    if let Err(error) = goal_runs::record_cleanup_unknown(&pool, &expired).await {
                        tracing::error!(
                            event = "native_goal_owner_cleanup_diagnostic_failed",
                            run_id = %expired.run_id,
                            error = %error,
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        event = "native_goal_owner_cleanup_receipt_invalid",
                        run_id = %expired.run_id,
                        error = %error,
                    );
                    if let Err(error) = goal_runs::record_cleanup_unknown(&pool, &expired).await {
                        tracing::error!(
                            event = "native_goal_owner_cleanup_diagnostic_failed",
                            run_id = %expired.run_id,
                            error = %error,
                        );
                    }
                }
            }
        }

        let pending_effects = match goal_costs::list_due_terminal_effects(&pool).await {
            Ok(pending) => pending,
            Err(error) => {
                tracing::warn!(event = "native_goal_terminal_effect_scan_failed", error = %error);
                sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        for terminal_effects in pending_effects {
            if shutdown.load(Ordering::Acquire) {
                break;
            }
            if let Err(error) = goal_costs::settle_terminal_effects(
                &pool,
                &terminal_effects.organization_id,
                &terminal_effects.run_id,
            )
            .await
            {
                tracing::error!(
                    event = "native_goal_terminal_effect_settlement_pending",
                    run_id = %terminal_effects.run_id,
                    error = %error,
                );
            }
        }
        // A failed ledger or budget effect must not permit another provider
        // launch in that organization before durable settlement is retried.
        let pending_effect_orgs = match goal_costs::pending_terminal_effect_organizations(&pool)
            .await
        {
            Ok(orgs) => orgs.into_iter().collect::<HashSet<_>>(),
            Err(error) => {
                tracing::warn!(event = "native_goal_terminal_effect_state_failed", error = %error);
                sleep(POLL_INTERVAL).await;
                continue;
            }
        };

        let due = match goal_runs::list_due_native_goal_wakeups(&pool).await {
            Ok(due) => due,
            Err(error) => {
                tracing::warn!(event = "native_goal_wakeup_scan_failed", error = %error);
                sleep(POLL_INTERVAL).await;
                continue;
            }
        };

        let mut claimed = false;
        for wakeup in due {
            if shutdown.load(Ordering::Acquire) {
                break;
            }
            if pending_effect_orgs.contains(&wakeup.organization_id) {
                continue;
            }
            match goal_runs::claim_wakeup(&pool, &wakeup.organization_id, &wakeup.wakeup_request_id)
                .await
            {
                Ok(Some(claim)) => {
                    claimed = true;
                    run_claim(&pool, &runtime, &identity, &shutdown, claim).await;
                    // Keep ownership sequential until the current run is
                    // terminal or visibly unresolved. The next claim is
                    // considered on the next bounded queue scan.
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        event = "native_goal_wakeup_claim_failed",
                        wakeup_request_id = %wakeup.wakeup_request_id,
                        error = %error,
                    );
                }
            }
        }

        if !claimed {
            sleep(POLL_INTERVAL).await;
        }
    }
}

async fn run_claim(
    pool: &PgPool,
    runtime: &NativeChatPublicRuntime,
    identity: &NativeIdentityAuthConfig,
    shutdown: &Arc<AtomicBool>,
    claim: GoalRunClaim,
) {
    let config = match goal_runs::resolve_claude_runtime(pool, &claim, &runtime.host).await {
        Ok(config) => config,
        Err(error) => {
            finalize_unlaunched_failure(
                pool,
                &claim,
                "goal_runtime_configuration",
                &error.to_string(),
            )
            .await;
            return;
        }
    };
    let Some(claude) = config.claude.as_ref() else {
        finalize_unlaunched_failure(
            pool,
            &claim,
            "goal_runtime_configuration",
            "resolved Goal Agent has no Claude runtime configuration",
        )
        .await;
        return;
    };
    let resources = match load_goal_started_resources(
        pool,
        &claim.organization_id,
        &claim.agent_id,
        &claude.memory_dir,
    )
    .await
    {
        Ok(resources) => resources,
        Err(error) => {
            finalize_unlaunched_failure(
                pool,
                &claim,
                "goal_context_unavailable",
                &error.to_string(),
            )
            .await;
            return;
        }
    };
    let Some(prompt_context) = goal_prompt_context(&claim, &config, claude) else {
        finalize_unlaunched_failure(
            pool,
            &claim,
            "goal_context_unavailable",
            "trusted organization workspace context is unavailable",
        )
        .await;
        return;
    };
    let invocation_input = GoalRunContextInput {
        agent_id: &claim.agent_id,
        organization_id: &claim.organization_id,
        agent_name: &claim.agent_name,
        agent_context: &claim.agent_context,
        runtime_type: &claim.runtime_type,
        run_id: &claim.run_id,
        wake_reason: &claim.reason,
        invocation_source: &claim.invocation_source,
        trigger_detail: claim.trigger_detail.as_deref(),
        context_snapshot: &claim.context_snapshot,
        prompt_context: &prompt_context,
        configured_prompt_template: claude.prompt_template.as_deref(),
    };
    let invocation =
        match build_goal_run_invocation(&invocation_input, &identity.agent_jwt, &resources) {
            Ok(invocation) => invocation,
            Err(error) => {
                finalize_unlaunched_failure(
                    pool,
                    &claim,
                    "goal_context_unavailable",
                    &error.to_string(),
                )
                .await;
                return;
            }
        };

    if shutdown.load(Ordering::Acquire) {
        request_shutdown_cancel(pool, &claim).await;
        finalize_unlaunched_cancel(pool, &claim).await;
        return;
    }

    let timeout = claude
        .timeout_sec
        .map(Duration::from_secs)
        .unwrap_or(runtime.timeout);
    let cancel_organization_id = claim.organization_id.clone();
    let cancel_run_id = claim.run_id.clone();
    let execution_stop = Arc::new(AtomicBool::new(false));
    let execution = execute_goal_claude_run(
        pool.clone(),
        claim,
        config,
        runtime.paths.clone(),
        invocation.prompt,
        invocation.env,
        invocation.instruction_context_sections,
        Arc::clone(&execution_stop),
        timeout,
    );
    tokio::pin!(execution);

    let outcome = loop {
        tokio::select! {
            biased;
            result = &mut execution => break result,
            _ = sleep(Duration::from_millis(100)),
                if shutdown.load(Ordering::Acquire)
                    && !execution_stop.load(Ordering::Acquire) =>
            {
                // Persist cancellation intent before asking the executor to
                // interrupt the owned process. The join continues through
                // process cleanup and durable finalization.
                request_shutdown_cancel_by_ids(
                    pool,
                    &cancel_organization_id,
                    &cancel_run_id,
                )
                .await;
                execution_stop.store(true, Ordering::Release);
            }
        }
    };

    match outcome {
        Ok((claim, observation)) => finalize_observation(pool, &claim, observation).await,
        Err(error) => tracing::error!(
            event = "native_goal_execution_unresolved",
            error = %error,
        ),
    }
}

async fn request_shutdown_cancel(pool: &PgPool, claim: &GoalRunClaim) {
    request_shutdown_cancel_by_ids(pool, &claim.organization_id, &claim.run_id).await;
}

async fn request_shutdown_cancel_by_ids(pool: &PgPool, organization_id: &str, run_id: &str) {
    match goal_runs::request_cancel(pool, organization_id, run_id, "server shutdown requested")
        .await
    {
        Ok(_) => {}
        Err(error) => tracing::warn!(
            event = "native_goal_shutdown_cancel_persist_failed",
            run_id = %run_id,
            error = %error,
        ),
    }
}

async fn finalize_unlaunched_failure(
    pool: &PgPool,
    claim: &GoalRunClaim,
    error_code: &str,
    error: &str,
) {
    let result = json!({"errorCode": error_code, "error": error});
    match goal_runs::finalize_unlaunched(pool, claim, "failed", Some(error), &Value::Null, &result)
        .await
    {
        Ok(true) => settle_terminal_effects(pool, claim).await,
        Ok(false) => tracing::warn!(
            event = "native_goal_unlaunched_failure_unresolved",
            run_id = %claim.run_id,
            error_code,
        ),
        Err(error) => tracing::error!(
            event = "native_goal_unlaunched_finalization_failed",
            run_id = %claim.run_id,
            error = %error,
        ),
    }
}

async fn finalize_unlaunched_cancel(pool: &PgPool, claim: &GoalRunClaim) {
    let result = json!({"errorCode":"cancelled","error":"server shutdown requested"});
    match goal_runs::finalize_unlaunched(
        pool,
        claim,
        "cancelled",
        Some("server shutdown requested"),
        &Value::Null,
        &result,
    )
    .await
    {
        Ok(true) => settle_terminal_effects(pool, claim).await,
        Ok(false) => tracing::warn!(
            event = "native_goal_unlaunched_cancel_unresolved",
            run_id = %claim.run_id,
        ),
        Err(error) => tracing::error!(
            event = "native_goal_unlaunched_cancel_finalization_failed",
            run_id = %claim.run_id,
            error = %error,
        ),
    }
}

async fn finalize_observation(
    pool: &PgPool,
    claim: &GoalRunClaim,
    observation: GoalRunExecutionObservation,
) {
    let Some(proof) = observation.cleanup_proof.as_ref() else {
        // A provider result without matching process-host cleanup is not a
        // terminal Run result. Keep ownership visible for reconciliation.
        // The D1 helper itself permits this only when the launch capability
        // remains unspent and no process identity was ever persisted.
        let result = json!({
            "errorCode": observation.error_code.as_deref().unwrap_or("goal_run_unresolved"),
            "error": observation.error.as_deref().unwrap_or("provider cleanup was not proven"),
        });
        match goal_runs::finalize_unlaunched(
            pool,
            claim,
            if observation.state == GoalRunExecutionState::Cancelled {
                "cancelled"
            } else {
                "failed"
            },
            observation.error.as_deref(),
            &observation.usage,
            &result,
        )
        .await
        {
            Ok(true) => {
                settle_terminal_effects(pool, claim).await;
                return;
            }
            Ok(false) => {}
            Err(error) => tracing::error!(
                event = "native_goal_unlaunched_finalization_failed",
                run_id = %claim.run_id,
                error = %error,
            ),
        }
        tracing::error!(
            event = "native_goal_cleanup_proof_missing",
            run_id = %claim.run_id,
            state = ?observation.state,
        );
        return;
    };
    let status = match observation.state {
        GoalRunExecutionState::Succeeded => "succeeded",
        GoalRunExecutionState::Failed => "failed",
        GoalRunExecutionState::Cancelled => "cancelled",
        GoalRunExecutionState::TimedOut => "timed_out",
        GoalRunExecutionState::Unresolved => {
            tracing::error!(
                event = "native_goal_execution_unresolved",
                run_id = %claim.run_id,
                error_code = ?observation.error_code,
            );
            return;
        }
    };
    match goal_runs::finalize(
        pool,
        claim,
        status,
        None,
        None,
        &observation.usage,
        &observation.result,
        observation.error.as_deref(),
        proof,
    )
    .await
    {
        Ok(true) => settle_terminal_effects(pool, claim).await,
        Ok(false) => tracing::error!(
            event = "native_goal_finalization_unresolved",
            run_id = %claim.run_id,
        ),
        Err(error) => tracing::error!(
            event = "native_goal_finalization_failed",
            run_id = %claim.run_id,
            error = %error,
        ),
    }
}

async fn settle_terminal_effects(pool: &PgPool, claim: &GoalRunClaim) {
    if let Err(error) =
        goal_costs::settle_terminal_effects(pool, &claim.organization_id, &claim.run_id).await
    {
        tracing::error!(
            event = "native_goal_terminal_effect_settlement_pending",
            run_id = %claim.run_id,
            error = %error,
        );
    }
}
