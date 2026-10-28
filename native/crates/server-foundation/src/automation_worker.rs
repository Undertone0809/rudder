//! Automation cadence and durable producer handoff. Provider execution remains
//! in the existing generic Agent and Native Chat workers.
use crate::{
    native_chat_worker::{Job, Supervisor},
    public_ingress_config::NativeChatPublicRuntime,
};
use rudder_d1_persistence::{automation_execution, native_chat};
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;

pub(crate) struct AutomationWorker {
    shutdown: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}
impl AutomationWorker {
    pub(crate) fn start(
        pool: PgPool,
        runtime: Option<NativeChatPublicRuntime>,
        supervisor: Option<Supervisor>,
        environment: &BTreeMap<String, String>,
    ) -> Self {
        let enabled = environment
            .get("HEARTBEAT_SCHEDULER_ENABLED")
            .is_none_or(|v| v != "false");
        let interval = environment
            .get("HEARTBEAT_SCHEDULER_INTERVAL_MS")
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v != 0.0)
            .unwrap_or(30_000.0)
            .max(10_000.0);
        let interval = Duration::from_secs_f64(interval / 1000.0);
        let shutdown = Arc::new(AtomicBool::new(false));
        let control = shutdown.clone();
        let task = tokio::spawn(async move {
            // The legacy interval does not fire immediately at startup.
            let mut last_tick = Instant::now();
            while !control.load(Ordering::Acquire) {
                if enabled && last_tick.elapsed() >= interval {
                    last_tick = Instant::now();
                    let now =
                        (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
                    let host = automation_execution::Host {
                        chat: runtime.as_ref().map(|v| &v.host),
                    };
                    if let Err(error) = automation_execution::tick(&pool, now, &host).await {
                        tracing::warn!(event="native_automation_schedule_failed",error=%error);
                    }
                }
                if let (Some(runtime), Some(supervisor)) = (&runtime, &supervisor) {
                    match native_chat::list_automation_jobs(&pool).await {
                        Ok(jobs) => {
                            for job in jobs {
                                if control.load(Ordering::Acquire) {
                                    break;
                                }
                                match Job::new_automation(
                                    job,
                                    runtime.host.clone(),
                                    runtime.paths.clone(),
                                    runtime.timeout,
                                ) {
                                    Ok(job) => match supervisor.try_start(job) {
                                        Ok(_)
                                        | Err(crate::native_chat_worker::StartError::Busy) => (),
                                        Err(error) => {
                                            tracing::warn!(event="native_automation_chat_dispatch_pending",error=%error)
                                        }
                                    },
                                    Err(error) => {
                                        tracing::warn!(event="native_automation_chat_job_invalid",error=%error)
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            tracing::warn!(event="native_automation_chat_discovery_failed",error=%error)
                        }
                    }
                }
                if let Err(error) = automation_execution::reconcile_chat_runs(&pool).await {
                    tracing::warn!(event="native_automation_chat_backlink_pending",error=%error);
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
        Self {
            shutdown,
            task: Some(task),
        }
    }
    pub(crate) async fn shutdown(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            if let Err(error) = task.await {
                tracing::error!(event="native_automation_worker_join_failed",error=%error);
            }
        }
    }
}
impl Drop for AutomationWorker {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
    }
}
