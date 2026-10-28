use super::{
    approvals, live,
    logs::{RunLogs, now},
};
use crate::{
    agent_run_context::{self, AgentRunContextHost},
    live_events::LiveEventPublisher,
    native_agent_jwt::NativeAgentJwtConfig,
};
use rudder_d1_persistence::agent_execution::{
    self, AgentRunClaim, AgentRunObserver, lifecycle, output,
};
use rudder_native_chat_executor::agent_run::{
    AgentRunApprovalDecision, AgentRunCleanupProof, AgentRunExecutionState, AgentRunOutput,
    AgentRunRequest, execute_agent_run, parse_agent_provider_event,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinSet, time::Instant};

struct Drain {
    pool: PgPool,
    events: LiveEventPublisher,
    owner: AgentRunObserver,
    runtime: String,
    logs: RunLogs,
    cancelled: Arc<AtomicBool>,
    approvals: JoinSet<()>,
    approval_ids: Vec<String>,
    metadata: Value,
}
impl Drain {
    async fn receive(
        &mut self,
        item: AgentRunOutput,
        last_event_seq: &mut i32,
    ) -> Result<(), String> {
        match item {
            AgentRunOutput::Log {
                stream,
                offset,
                chunk,
            } => {
                self.logs.provider_bytes(stream, offset, chunk)?;
                return Ok(());
            }
            AgentRunOutput::Event { offset, mut event } => {
                self.logs.redact_value(&mut event);
                if event["type"] == "rudder.context.log" {
                    self.logs.context_log(&event)?;
                    return Ok(());
                } else {
                    self.logs.transcript.extend(parse_agent_provider_event(
                        &self.runtime,
                        &event,
                        &now(),
                    ));
                }
                let namespace = if event["type"] == "rudder.context.log" {
                    "context"
                } else {
                    "provider"
                };
                output::event(
                    &self.pool,
                    &self.owner,
                    &format!("{namespace}:{offset}"),
                    "adapter.event",
                    "system",
                    &event,
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            AgentRunOutput::InvocationMeta { mut metadata } => {
                if metadata.is_object() {
                    metadata["runtimeSkills"] = self.metadata["runtimeSkills"].clone();
                    metadata["managedMcp"] = self.metadata["managedMcp"].clone();
                }
                self.logs.redact_value(&mut metadata);
                output::event(
                    &self.pool,
                    &self.owner,
                    "invocation-meta",
                    "adapter.invoke",
                    "system",
                    &metadata,
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            AgentRunOutput::ApprovalRequest {
                offset,
                provider_run_id,
                session_id,
                event,
                timeout,
                reply,
            } => {
                let payload = approvals::payload(event, &provider_run_id, &session_id);
                match agent_execution::create_runtime_approval(
                    &self.pool,
                    &self.owner,
                    &self.runtime,
                    &format!("{}:{offset}", self.owner.attempt_id()),
                    &payload,
                )
                .await
                {
                    Ok(row) => {
                        self.approval_ids.push(row.id.clone());
                        self.approvals.spawn(approvals::resolve(
                            self.pool.clone(),
                            self.owner.clone(),
                            row.id,
                            row.status,
                            timeout,
                            Arc::clone(&self.cancelled),
                            reply,
                        ));
                    }
                    Err(error) => {
                        let _ = reply.send(AgentRunApprovalDecision {
                            approval_id: None,
                            choice: None,
                            error: Some(error.to_string()),
                        });
                    }
                }
            }
        }
        live::committed(
            &self.pool,
            &self.events,
            self.owner.organization_id(),
            self.owner.run_id(),
            last_event_seq,
            false,
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    async fn drain_ready(
        &mut self,
        receiver: &mut mpsc::Receiver<AgentRunOutput>,
        last_event_seq: &mut i32,
    ) -> Result<(), String> {
        while let Ok(item) = receiver.try_recv() {
            self.receive(item, last_event_seq).await?;
        }
        Ok(())
    }
}

pub(super) async fn run(
    pool: PgPool,
    host: Arc<AgentRunContextHost>,
    identity: NativeAgentJwtConfig,
    shutdown: Arc<AtomicBool>,
    claim: AgentRunClaim,
    events: LiveEventPublisher,
) {
    let mut claim = claim;
    let mut plan = None;
    let mut failed_auth = HashSet::new();
    let mut transcript = Vec::new();
    let mut last_event_seq = 0;
    let org = claim.organization_id.clone();
    let run_id = claim.run_id.clone();
    while let Some(next) = run_attempt(
        pool.clone(),
        Arc::clone(&host),
        identity.clone(),
        Arc::clone(&shutdown),
        claim,
        &mut plan,
        &mut failed_auth,
        &mut transcript,
        &events,
        &mut last_event_seq,
    )
    .await
    {
        claim = next;
    }
    let _ = live::committed(&pool, &events, &org, &run_id, &mut last_event_seq, true).await;
    let _ = live::status(&pool, &events, &org, &run_id).await;
}

#[allow(clippy::too_many_arguments)] // Carry the same owned attempt and durable output cursors through fallback.
async fn run_attempt(
    pool: PgPool,
    host: Arc<AgentRunContextHost>,
    identity: NativeAgentJwtConfig,
    shutdown: Arc<AtomicBool>,
    claim: AgentRunClaim,
    plan: &mut Option<Vec<agent_execution::model_attempts::ModelAttempt>>,
    failed_auth: &mut HashSet<String>,
    transcript: &mut Vec<Value>,
    events: &LiveEventPublisher,
    last_event_seq: &mut i32,
) -> Option<AgentRunClaim> {
    let _ = live::status(&pool, events, &claim.organization_id, &claim.run_id).await;
    let _ = live::committed(
        &pool,
        events,
        &claim.organization_id,
        &claim.run_id,
        last_event_seq,
        false,
    )
    .await;
    let owner = claim.owned.observer();
    let cancelled = Arc::new(AtomicBool::new(false));
    let logs = match RunLogs::begin(
        &pool,
        owner.clone(),
        &claim.runtime_type,
        &host.workspace.instance_root,
        events.clone(),
    )
    .await
    {
        Ok(logs) => logs,
        Err(error) => {
            unlaunched(&pool, &claim, "agent_run_log_unavailable", &error, false).await;
            return None;
        }
    };
    let (sender, mut receiver) = mpsc::channel(256);
    let mut drain = Drain {
        pool: pool.clone(),
        events: events.clone(),
        owner: owner.clone(),
        runtime: claim.runtime_type.clone(),
        logs,
        cancelled: Arc::clone(&cancelled),
        approvals: JoinSet::new(),
        approval_ids: Vec::new(),
        metadata: json!({}),
    };
    let mut io_error = None;
    let prepared = {
        let preparation = agent_run_context::prepare_agent_run_invocation(
            &pool,
            &claim,
            &host,
            &identity,
            &cancelled,
            Some(sender.clone()),
        );
        tokio::pin!(preparation);
        let mut next_renew = Instant::now() + Duration::from_secs(10);
        let mut prepare_tick = tokio::time::interval(Duration::from_millis(500));
        prepare_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                result=&mut preparation=>break result,
                Some(item)=receiver.recv()=>if let Err(error)=drain.receive(item,last_event_seq).await{io_error=Some(error);cancelled.store(true,Ordering::Release);},
                _=prepare_tick.tick()=>{
                    let _=live::committed(&pool,events,&claim.organization_id,&claim.run_id,last_event_seq,false).await;
                    if shutdown.load(Ordering::Acquire){let _=output::request_cancel(&pool,&owner,"Server shutdown requested").await;cancelled.store(true,Ordering::Release);}
                    if lifecycle::cancellation_requested(&pool,&claim.owned).await.unwrap_or(true){cancelled.store(true,Ordering::Release);}
                    if Instant::now()>=next_renew{let renewed=if cancelled.load(Ordering::Acquire){lifecycle::renew_cleanup_lease(&pool,&claim.owned,Duration::from_secs(30)).await}else{lifecycle::renew_lease(&pool,&claim.owned,Duration::from_secs(30)).await};if !renewed.unwrap_or(false){cancelled.store(true,Ordering::Release);}next_renew=Instant::now()+Duration::from_secs(10);}
                }
            }
        }
    };
    let mut prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = drain.drain_ready(&mut receiver, last_event_seq).await;
            let _ = drain.logs.finish(&pool).await;
            unlaunched(
                &pool,
                &claim,
                "agent_context_unavailable",
                io_error.as_deref().unwrap_or(&error.to_string()),
                cancelled.load(Ordering::Acquire),
            )
            .await;
            return None;
        }
    };
    drain.logs.set_secrets(
        prepared
            .secret_keys
            .iter()
            .filter_map(|key| prepared.env.get(key).cloned())
            .collect(),
    );
    drain.metadata = json!({"runtimeSkills":prepared.runtime_skills,"managedMcp":prepared.context.get("managedMcpPolicySnapshot")});
    if cancelled.load(Ordering::Acquire) || io_error.is_some() {
        let error =
            io_error.unwrap_or_else(|| "Agent invocation cancelled during preparation".into());
        if let Err(error) = prepared.abort_before_provider(&pool).await {
            tracing::error!(event="native_agent_preparation_cleanup_unresolved",run_id=%claim.run_id,error=%error);
            return None;
        }
        let _ = drain.drain_ready(&mut receiver, last_event_seq).await;
        let _ = drain.logs.finish(&pool).await;
        unlaunched(
            &pool,
            &claim,
            "agent_context_incomplete",
            &error,
            cancelled.load(Ordering::Acquire),
        )
        .await;
        return None;
    }
    if plan.is_none() {
        *plan = Some(agent_execution::model_attempts::build(
            &prepared.attempt_config_template,
            claim
                .agent_context
                .get("agentRuntimeType")
                .and_then(Value::as_str)
                .unwrap_or(&claim.runtime_type),
        ));
    }
    let Some(spec) = plan.as_ref().and_then(|attempts| {
        attempts
            .iter()
            .find(|attempt| attempt.index == claim.model_attempt_index)
    }) else {
        let _ = prepared.abort_before_provider(&pool).await;
        unlaunched(
            &pool,
            &claim,
            "model_attempt_unavailable",
            "Persisted model attempt configuration is unavailable",
            false,
        )
        .await;
        return None;
    };
    match agent_execution::attempts::record_model(&pool, &claim, spec).await {
        Ok(true) => {}
        _ => {
            let _ = prepared.abort_before_provider(&pool).await;
            unlaunched(
                &pool,
                &claim,
                "cancelled",
                "Agent invocation stopped before provider launch",
                true,
            )
            .await;
            return None;
        }
    }
    prepared.mark_provider_launch_possible();
    let request = AgentRunRequest {
        prompt: prepared.prompt.clone(),
        context: prepared.context.clone(),
        config: prepared.config.clone(),
        cwd: prepared.cwd.clone(),
        process_host: host.process_host.clone(),
        runtime_root: host.runtime_root.clone(),
        env: prepared.env.clone(),
        managed_args: prepared.managed_args.clone(),
        output: Some(sender.clone()),
        cancelled: Arc::clone(&cancelled),
    };
    let execution = execute_agent_run(pool.clone(), claim, request);
    tokio::pin!(execution);
    let mut execution_tick = tokio::time::interval(Duration::from_millis(100));
    execution_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut next_event_poll = Instant::now();
    let outcome = loop {
        tokio::select! {
                   result=&mut execution=>break result,
                   Some(item)=receiver.recv()=>if let Err(error)=drain.receive(item,last_event_seq).await{io_error=Some(error);cancelled.store(true,Ordering::Release);},
                   _=execution_tick.tick()=>{if shutdown.load(Ordering::Acquire)&&!cancelled.load(Ordering::Acquire){let _=output::request_cancel(&pool,&owner,"Server shutdown requested").await;cancelled.store(true,Ordering::Release);}
        if Instant::now()>=next_event_poll{let _=live::committed(&pool,events,owner.organization_id(),owner.run_id(),last_event_seq,false).await;next_event_poll=Instant::now()+Duration::from_millis(500);}}
               }
    };
    let (mut claim, mut observation) = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::error!(event="native_agent_execution_unresolved",run_id=%owner.run_id(),error=%error);
            return None;
        }
    };
    let _ = drain.drain_ready(&mut receiver, last_event_seq).await;
    while let Some(result) = drain.approvals.join_next().await {
        if let Err(error) = result {
            tracing::warn!(event="native_agent_approval_observer_failed",error=%error);
        }
    }
    if !observation.result.is_object() {
        observation.result = json!({});
    }
    if observation.clear_session {
        observation.result["sessionId"] = Value::Null;
        observation.result["sessionParamsAfter"] = json!({});
    } else if let Some(id) = observation.session_id.as_ref() {
        observation.result["sessionId"] = json!(id);
        observation.result["sessionParamsAfter"] = json!(observation.session_params);
    }
    if let Some(id) = drain.approval_ids.last()
        && observation
            .result
            .pointer("/approval/rudderApprovalId")
            .is_none_or(Value::is_null)
    {
        if !observation.result["approval"].is_object() {
            observation.result["approval"] = json!({});
        }
        observation.result["approval"]["rudderApprovalId"] = json!(id);
    }
    if let Some(failure) = observation.result.get("providerFailure")
        && let Err(error) = output::provider_failure(&pool, &owner, failure).await
    {
        tracing::warn!(event="native_agent_readiness_persist_failed",run_id=%claim.run_id,error=%error);
    }
    let proof = observation.cleanup_proof.as_ref();
    if proof.is_none() && !claim.owned.launch_permit_unspent() {
        tracing::error!(event="native_agent_cleanup_proof_missing",run_id=%claim.run_id);
        return None;
    }
    if proof.is_none() && observation.state == AgentRunExecutionState::Unresolved {
        observation.state = if cancelled.load(Ordering::Acquire) {
            AgentRunExecutionState::Cancelled
        } else {
            AgentRunExecutionState::Failed
        };
    }
    let cleanup = {
        let finish = async {
            match proof {
                Some(proof) => prepared.finish(&pool, &claim, proof).await,
                None => prepared.abort_unlaunched(&pool, &claim).await,
            }
        };
        tokio::pin!(finish);
        let mut next_cleanup_renew = Instant::now() + Duration::from_secs(10);
        let mut cleanup_tick = tokio::time::interval(Duration::from_millis(500));
        cleanup_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {result=&mut finish=>break result,Some(item)=receiver.recv()=>if let Err(error)=drain.receive(item,last_event_seq).await{io_error=Some(error);},_=cleanup_tick.tick()=>{if Instant::now()>=next_cleanup_renew{let _=lifecycle::renew_cleanup_lease(&pool,&claim.owned,Duration::from_secs(30)).await;next_cleanup_renew=Instant::now()+Duration::from_secs(10);}}}
        }
    };
    if let Err(error) = cleanup {
        tracing::error!(event="native_agent_context_cleanup_unresolved",run_id=%claim.run_id,error=%error);
        return None;
    }
    let _ = drain.drain_ready(&mut receiver, last_event_seq).await;
    if let Err(error) = drain.logs.finish(&pool).await {
        io_error = Some(error);
    }
    transcript.append(&mut drain.logs.transcript);
    observation.result["transcript"] = json!(transcript);
    if let Some(code) = observation.error_code.as_ref() {
        observation.result["errorCode"] = json!(code);
    }
    if let Some(error) = io_error {
        observation.result["outputPersistenceError"] = json!(error);
        if observation.state == AgentRunExecutionState::Succeeded {
            observation.state = AgentRunExecutionState::Failed;
            observation.error_code = Some("run_output_persistence_failed".into());
            observation.result["errorCode"] = json!("run_output_persistence_failed");
            observation.error =
                Some("Runtime finished, but its complete Run output could not be saved".into());
        }
    }
    if observation.state == AgentRunExecutionState::Suspended {
        let mut checkpoint = observation
            .result
            .get("networkSuspension")
            .cloned()
            .unwrap_or(Value::Null);
        if checkpoint.is_object() {
            checkpoint["modelAttemptIndex"] = json!(claim.model_attempt_index);
            checkpoint["runtimeType"] = json!(claim.runtime_type);
        }
        let waiting = match proof {
            Some(AgentRunCleanupProof::Process(proof)) => {
                agent_execution::network::suspend_process(
                    &pool,
                    &claim.owned,
                    &checkpoint,
                    &observation.usage,
                    observation.session_id.as_deref(),
                    observation.session_params.as_ref(),
                    proof,
                )
                .await
            }
            Some(AgentRunCleanupProof::Request(proof)) => {
                agent_execution::network::suspend_request(
                    &pool,
                    &claim.owned,
                    &checkpoint,
                    &observation.usage,
                    observation.session_id.as_deref(),
                    observation.session_params.as_ref(),
                    proof,
                )
                .await
            }
            None => {
                tracing::error!(event="native_agent_network_wait_cleanup_missing",run_id=%claim.run_id);
                return None;
            }
        };
        match waiting {
            Ok(true) => {
                let _ = live::status(&pool, events, &claim.organization_id, &claim.run_id).await;
                return None;
            }
            Ok(false)
                if lifecycle::cancellation_requested(&pool, &claim.owned)
                    .await
                    .unwrap_or(false) =>
            {
                observation.state = AgentRunExecutionState::Cancelled;
                observation.error = Some("Agent invocation cancelled".into());
                observation.result["errorCode"] = json!("cancelled");
            }
            Ok(false) => {
                tracing::error!(event="native_agent_network_wait_owner_lost",run_id=%claim.run_id);
                return None;
            }
            Err(error) => {
                tracing::error!(event="native_agent_network_wait_persist_failed",run_id=%claim.run_id,error=%error);
                return None;
            }
        }
    }
    if matches!(
        observation.state,
        AgentRunExecutionState::Failed | AgentRunExecutionState::TimedOut
    ) && !cancelled.load(Ordering::Acquire)
        && !shutdown.load(Ordering::Acquire)
        && observation.result["errorCode"] != "run_output_persistence_failed"
    {
        if observation
            .result
            .pointer("/providerFailure/classification")
            .and_then(Value::as_str)
            == Some("authentication")
            && observation
                .result
                .pointer("/providerFailure/retryable")
                .and_then(Value::as_bool)
                == Some(false)
        {
            failed_auth.insert(claim.runtime_type.clone());
        }
        if let Some(next) = plan.as_ref().and_then(|attempts| {
            attempts.iter().find(|attempt| {
                attempt.index > claim.model_attempt_index
                    && !failed_auth.contains(&attempt.runtime_type)
            })
        }) {
            let failure = agent_execution::attempts::Failure {
                status: if observation.state == AgentRunExecutionState::TimedOut {
                    "timed_out"
                } else {
                    "failed"
                },
                error_code: observation.error_code.as_deref(),
                error: observation.error.as_deref(),
                usage: &observation.usage,
                session_id: observation.session_id.as_deref(),
                session_params: observation.session_params.as_ref(),
            };
            let cleanup = match proof {
                Some(AgentRunCleanupProof::Process(proof)) => {
                    agent_execution::attempts::Cleanup::Process(proof)
                }
                Some(AgentRunCleanupProof::Request(proof)) => {
                    agent_execution::attempts::Cleanup::Request(proof)
                }
                None => agent_execution::attempts::Cleanup::Unlaunched,
            };
            match agent_execution::attempts::advance(&pool, &mut claim, next, failure, cleanup)
                .await
            {
                Ok(Some(next)) => return Some(next),
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(event="native_agent_fallback_advance_failed",run_id=%claim.run_id,error=%error);
                    return None;
                }
            }
        }
    }
    let status = match observation.state {
        AgentRunExecutionState::Succeeded => "succeeded",
        AgentRunExecutionState::Failed => "failed",
        AgentRunExecutionState::Cancelled => "cancelled",
        AgentRunExecutionState::TimedOut => "timed_out",
        AgentRunExecutionState::Suspended | AgentRunExecutionState::Unresolved => {
            tracing::error!(event="native_agent_nonterminal_observation_pending",run_id=%claim.run_id,state=?observation.state);
            return None;
        }
    };
    let settled = match proof {
        Some(AgentRunCleanupProof::Process(proof)) => {
            lifecycle::finalize(
                &pool,
                &claim.owned,
                status,
                observation.exit_code,
                observation.signal.as_deref(),
                &observation.usage,
                &observation.result,
                observation.error.as_deref(),
                proof,
            )
            .await
        }
        Some(AgentRunCleanupProof::Request(proof)) => {
            lifecycle::finalize_request(
                &pool,
                &claim.owned,
                status,
                &observation.usage,
                &observation.result,
                observation.error.as_deref(),
                proof,
            )
            .await
        }
        None => {
            lifecycle::finalize_unlaunched(
                &pool,
                &claim.owned,
                status,
                observation.error.as_deref(),
                &observation.usage,
                &observation.result,
            )
            .await
        }
    };
    match settled {
        Ok(true) => {
            if let Err(error) = agent_execution::settlement::settle_terminal_effects(
                &pool,
                &claim.organization_id,
                &claim.run_id,
            )
            .await
            {
                tracing::error!(event="native_agent_terminal_effects_pending",run_id=%claim.run_id,error=%error);
            }
        }
        Ok(false) => {
            tracing::error!(event="native_agent_settlement_owner_lost",run_id=%claim.run_id)
        }
        Err(error) => {
            tracing::error!(event="native_agent_settlement_failed",run_id=%claim.run_id,error=%error)
        }
    }
    None
}
async fn unlaunched(
    pool: &PgPool,
    claim: &AgentRunClaim,
    code: &str,
    error: &str,
    cancelled: bool,
) {
    let result = json!({"errorCode":code,"error":error});
    match lifecycle::finalize_unlaunched(
        pool,
        &claim.owned,
        if cancelled { "cancelled" } else { "failed" },
        Some(error),
        &Value::Null,
        &result,
    )
    .await
    {
        Ok(true) => {
            let _ = agent_execution::settlement::settle_terminal_effects(
                pool,
                &claim.organization_id,
                &claim.run_id,
            )
            .await;
        }
        Ok(false) => {
            tracing::error!(event="native_agent_unlaunched_owner_lost",run_id=%claim.run_id)
        }
        Err(error) => {
            tracing::error!(event="native_agent_unlaunched_settlement_failed",run_id=%claim.run_id,error=%error)
        }
    }
}
