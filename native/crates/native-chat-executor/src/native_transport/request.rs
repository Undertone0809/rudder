use super::*;
use agent_run::{AgentRunApprovalChoice, AgentRunApprovalDecision, AgentRunOutput};
use std::{future::Future, pin::Pin, sync::atomic::Ordering, time::Duration};

#[allow(clippy::too_many_arguments)] // The existing Native Chat claim owns the entire request lifetime.
pub(super) async fn execute(
    pool: &PgPool,
    principal: &NativeChatExecutionPrincipal,
    fence: &ExecutionFence,
    invocation: execution::TransportInvocation,
    target: &RuntimeTransportTarget,
    request: &mut AgentRunRequest,
    external_cancelled: &AtomicBool,
    deadline: Instant,
) -> (
    AgentRunExecutionObservation,
    Option<TransportCleanupProof>,
    Option<execution::StopIntent>,
) {
    let configured_timeout = request.config[if target.runtime_type == "http" {
        "timeoutMs"
    } else {
        "timeoutSec"
    }]
    .as_f64()
    .or_else(|| (target.runtime_type != "http").then_some(120.0))
    .filter(|value| value.is_finite() && *value > 0.0)
    .and_then(|value| {
        Duration::try_from_secs_f64(if target.runtime_type == "http" {
            value / 1000.0
        } else {
            value
        })
        .ok()
    });
    let deadline = configured_timeout
        .and_then(|timeout| Instant::now().checked_add(timeout))
        .map_or(deadline, |configured| configured.min(deadline));
    let (sender, mut output) = tokio::sync::mpsc::channel(64);
    request.output = Some(sender);
    let ((observation,stop),proof)=invocation.settle(async {
        let mut pending=Box::pin(agent_run::invoke_transport(target,request));
        let mut tick=tokio::time::interval(Duration::from_millis(100));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_poll=Instant::now();
        let mut last_renew=Instant::now();
        let mut stop=None;
        let mut stopping=None;
        let mut approval:Option<Pin<Box<dyn Future<Output=()>+Send+'_>>>=None;
        loop {
            tokio::select! {
                observation=pending.as_mut()=>{
                    let mut observation=observation;
                    if let Some((state,code,message))=stopping {observation.state=state;observation.error_code=Some(code);observation.error=Some(message);}
                    return (observation,stop);
                },
                Some(event)=output.recv()=>match event {
                    AgentRunOutput::ApprovalRequest{provider_run_id,session_id,event,timeout,reply,..}=>{
                        if approval.is_none() { approval=Some(Box::pin(resolve_approval(pool,principal,fence,provider_run_id,session_id,event,timeout,reply,Arc::clone(&request.cancelled)))); }
                    }
                    // Gateway protocol events are retained in the returned
                    // bounded observation; they cannot grant terminal authority.
                    _=>(),
                },
                ()=async { if let Some(approval)=approval.as_mut(){approval.await}else{std::future::pending().await} }=>{approval=None;},
                _=tick.tick()=>{
                    if stopping.is_none() && (external_cancelled.load(Ordering::Acquire) || request.cancelled.load(Ordering::Acquire)) {stopping=Some((AgentRunExecutionState::Cancelled,"cancelled".into(),"Native Chat request cancelled".into()));}
                    if stopping.is_none() && Instant::now()>=deadline {stopping=Some((AgentRunExecutionState::TimedOut,"timeout".into(),"Native Chat request timed out".into()));}
                    if last_poll.elapsed()>=Duration::from_millis(500) {
                        last_poll=Instant::now();
                        match tokio::time::timeout(Duration::from_secs(5),execution::observe_stop(pool,principal,fence)).await {
                            Ok(Ok(Some(intent)))=>{stop=Some(intent);stopping.get_or_insert((AgentRunExecutionState::Cancelled,"cancelled".into(),"Native Chat Stop requested".into()));},
                            Ok(Ok(None))=>(),
                            _=>{stopping=Some((AgentRunExecutionState::Unresolved,"native_chat_ownership_lost".into(),"Native Chat request owner is unavailable".into()));},
                        }
                    }
                    if last_renew.elapsed()>=Duration::from_secs(10) {
                        last_renew=Instant::now();
                        let renewed=tokio::time::timeout(Duration::from_secs(5),async {
                            if let Some(stop)=&stop {execution::renew_stopping_lease(pool,principal,fence,stop).await}
                            else {execution::renew_lease(pool,principal,fence).await}
                        }).await;
                        if !matches!(renewed,Ok(Ok(_))) {stopping=Some((AgentRunExecutionState::Unresolved,"native_chat_ownership_lost".into(),"Native Chat request owner lease was lost".into()));}
                    }
                    if let Some((state,code,message))=&stopping {
                        request.cancelled.store(true,Ordering::Release);
                        if target.runtime_type=="http" { return (failure(*state,code,message),stop); }
                        // Gateway future owns remote stop/socket close; keep
                        // polling it through actual local settlement.
                    }
                },
            }
        }
    }).await;
    (
        observation,
        Some(TransportCleanupProof::Request(proof)),
        stop,
    )
}

#[allow(clippy::too_many_arguments)] // Exact provider approval request and current Native Chat owner.
async fn resolve_approval(
    pool: &PgPool,
    principal: &NativeChatExecutionPrincipal,
    fence: &ExecutionFence,
    provider_run: String,
    session: String,
    event: Value,
    timeout: Duration,
    reply: tokio::sync::oneshot::Sender<AgentRunApprovalDecision>,
    cancelled: Arc<AtomicBool>,
) {
    let key = format!("{}:{provider_run}:{session}", fence.identity().attempt_id);
    let result = execution::create_transport_approval(pool, principal, fence, &key, &event).await;
    let approval = match result {
        Ok(approval) => approval,
        Err(_) => {
            let _ = reply.send(AgentRunApprovalDecision {
                approval_id: None,
                choice: None,
                error: Some("Native Chat runtime approval could not be created".into()),
            });
            return;
        }
    };
    let started = Instant::now();
    let decision = loop {
        if cancelled.load(Ordering::Acquire) || started.elapsed() >= timeout {
            break AgentRunApprovalDecision {
                approval_id: Some(approval.id.clone()),
                choice: None,
                error: Some("Native Chat approval wait interrupted".into()),
            };
        }
        match execution::read_transport_approval(pool, principal, fence, &approval.id).await {
            Ok(approval) if approval.status == "approved" => {
                break AgentRunApprovalDecision {
                    approval_id: Some(approval.id),
                    choice: Some(AgentRunApprovalChoice::Once),
                    error: None,
                };
            }
            Ok(approval) if matches!(approval.status.as_str(), "rejected" | "cancelled") => {
                break AgentRunApprovalDecision {
                    approval_id: Some(approval.id),
                    choice: Some(AgentRunApprovalChoice::Deny),
                    error: None,
                };
            }
            Ok(_) => (),
            Err(_) => {
                break AgentRunApprovalDecision {
                    approval_id: Some(approval.id.clone()),
                    choice: None,
                    error: Some("Native Chat approval owner changed".into()),
                };
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    let _ = reply.send(decision);
}
