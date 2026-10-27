//! Persisted generic Agent queue driver. Startup mounts this only when its
//! complete public admission/context/runtime cutline is installed together.
mod approvals;
mod driver;
mod logs;
#[cfg(test)]
mod tests;
use crate::{
    agent_run_context::{AgentRunContextHost, finish_persisted_agent_run_context},
    native_agent_jwt::NativeAgentJwtConfig,
};
use rudder_d1_persistence::agent_execution::{self, recovery, settlement};
use sqlx::PgPool;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    task::{JoinHandle, JoinSet},
    time::sleep,
};

pub(crate) struct AgentRunWorker {
    shutdown: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}
impl AgentRunWorker {
    pub(crate) fn start(
        pool: PgPool,
        host: Arc<AgentRunContextHost>,
        identity: NativeAgentJwtConfig,
    ) -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let control = Arc::clone(&shutdown);
        let task = tokio::spawn(queue(pool, host, identity, control));
        Self {
            shutdown,
            task: Some(task),
        }
    }
    pub(crate) async fn shutdown(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            if let Err(error) = task.await {
                tracing::error!(event="native_agent_worker_join_failed",error=%error);
            }
        }
    }
}
impl Drop for AgentRunWorker {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
    }
}

async fn queue(
    pool: PgPool,
    host: Arc<AgentRunContextHost>,
    identity: NativeAgentJwtConfig,
    shutdown: Arc<AtomicBool>,
) {
    let mut tasks = JoinSet::new();
    let mut active = HashSet::new();
    let mut task_runs = HashMap::new();
    while !shutdown.load(Ordering::Acquire) {
        while let Some(result) = tasks.try_join_next() {
            match result {
                Ok(run) => {
                    active.remove(&run);
                    task_runs.retain(|_, value| value != &run);
                }
                Err(error) => {
                    if let Some(run) = task_runs.remove(&error.id()) {
                        active.remove(&run);
                    }
                    tracing::error!(event="native_agent_execution_task_lost",error=%error)
                }
            }
        }
        if let Err(error) = maintenance(&pool, &host, &active).await {
            tracing::warn!(event="native_agent_queue_maintenance_failed",error=%error);
        }
        let due = async {
            let mut due = agent_execution::list_due_runs(&pool)
                .await?
                .into_iter()
                .map(|run| (run, false))
                .collect::<Vec<_>>();
            due.extend(
                agent_execution::network::list_due(&pool)
                    .await?
                    .into_iter()
                    .map(|run| (run, true)),
            );
            Ok::<_, agent_execution::AgentExecutionError>(due)
        }
        .await;
        match due {
            Ok(due) => {
                for (due, network) in due {
                    if shutdown.load(Ordering::Acquire) {
                        break;
                    }
                    if active.contains(&due.run_id) {
                        continue;
                    }
                    let claimed = if network {
                        agent_execution::claim_network_waiting_run(
                            &pool,
                            &due.organization_id,
                            &due.run_id,
                        )
                        .await
                    } else {
                        agent_execution::claim_queued_run(&pool, &due.organization_id, &due.run_id)
                            .await
                    };
                    match claimed {
                        Ok(Some(claim)) => {
                            let run = claim.run_id.clone();
                            active.insert(run.clone());
                            let pool = pool.clone();
                            let host = Arc::clone(&host);
                            let identity = identity.clone();
                            let shutdown = Arc::clone(&shutdown);
                            let task = tasks.spawn(async move {
                                driver::run(pool, host, identity, shutdown, claim).await;
                                run
                            });
                            task_runs.insert(task.id(), due.run_id.clone());
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(event="native_agent_queue_claim_failed",run_id=%due.run_id,error=%error)
                        }
                    }
                }
            }
            Err(error) => tracing::warn!(event="native_agent_queue_scan_failed",error=%error),
        }
        tokio::select! {
            result=tasks.join_next(),if !tasks.is_empty()=>{
                match result {
                    Some(Ok(run))=>{active.remove(&run);task_runs.retain(|_,value|value!=&run);},
                    Some(Err(error))=>{if let Some(run)=task_runs.remove(&error.id()){active.remove(&run);}tracing::error!(event="native_agent_execution_task_lost",error=%error);},
                    None=>{}
                }
            },
            _=sleep(Duration::from_millis(500))=>{}
        }
    }
    // Shutdown sets every invocation's shared control and joins actual cleanup;
    // dropping a task/future is never used as cancellation acknowledgement.
    while let Some(result) = tasks.join_next().await {
        if let Err(error) = result {
            tracing::error!(event="native_agent_shutdown_join_failed",error=%error);
        }
    }
}
async fn maintenance(
    pool: &PgPool,
    host: &AgentRunContextHost,
    active: &HashSet<String>,
) -> Result<(), agent_execution::AgentExecutionError> {
    for expired in recovery::list_expired(pool).await? {
        if active.contains(&expired.run_id) {
            continue;
        }
        let recovered = if expired.request_started() {
            recovery::recover_request_owner_lost(pool, &expired).await?
        } else {
            match expired.read_process_cleanup_receipt(&host.runtime_root) {
                Ok(Some(receipt)) => {
                    recovery::recover_process_with_cleanup_receipt(pool, &expired, &receipt).await?
                }
                Ok(None) | Err(_) => {
                    recovery::record_cleanup_unknown(pool, &expired).await?;
                    false
                }
            }
        };
        if recovered {
            if let Err(error) =
                finish_persisted_agent_run_context(pool, &expired.organization_id, &expired.run_id, &host.runtime_root)
                    .await
            {
                tracing::warn!(event="native_agent_recovered_context_cleanup_pending",run_id=%expired.run_id,error=%error);
            }
        }
    }
    for due in settlement::list_due(pool).await? {
        if let Err(error) =
            finish_persisted_agent_run_context(pool, &due.organization_id, &due.run_id, &host.runtime_root).await
        {
            tracing::warn!(event="native_agent_terminal_context_cleanup_pending",run_id=%due.run_id,error=%error);
            continue;
        }
        if let Err(error) =
            settlement::settle_terminal_effects(pool, &due.organization_id, &due.run_id).await
        {
            tracing::error!(event="native_agent_terminal_effects_pending",run_id=%due.run_id,error=%error);
        }
    }
    agent_execution::resume_pending(pool).await?;
    Ok(())
}
