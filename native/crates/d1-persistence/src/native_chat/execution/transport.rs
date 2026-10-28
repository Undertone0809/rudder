//! The existing Native Chat claim owns exactly one process or request. The
//! checkpoint commits before dispatch; restart never recreates this capability.
use super::{ExecutionFence, Result, StopIntent, SubmissionInput, context, http, submission};
use crate::native_chat::NativeChatExecutionActor;
use rudder_codex_app_server::ConnectionLaunchPermit;
use rudder_runtime_core::native_chat::NativeChatProtocolCheckpoint;
use sqlx::PgPool;
use std::future::Future;

/// A bounded observation from the actual owned transport, never an HTTP DTO.
pub struct TransportTurnReceipt {
    pub request_id: String,
    pub session_id: Option<String>,
    pub final_text: Option<String>,
    pub status: super::NativeProviderStatus,
    pub usage: Option<serde_json::Value>,
    pub evidence: serde_json::Value,
}

pub enum TransportCleanupProof {
    Process(rudder_native_process_transport::HostCleanupProof),
    Request(TransportRequestProof),
}

impl TransportCleanupProof {
    pub fn matches(&self, fence: &ExecutionFence) -> bool {
        match self {
            Self::Process(proof) => fence.matches_host_cleanup_proof(proof),
            Self::Request(proof) => proof.matches(fence),
        }
    }
    pub fn connection_receipt_id(&self) -> &str {
        match self {
            Self::Process(proof) => proof.connection_receipt_id(),
            Self::Request(proof) => proof.connection_receipt_id(),
        }
    }
}

pub struct TransportInvocation {
    fence: ExecutionFence,
    input: SubmissionInput,
    permit: ConnectionLaunchPermit,
    request_id: String,
    receipt_id: String,
}

/// Only proves that the complete local request future returned. Remote work
/// may remain unknown after a Gateway abort acknowledgement or backend loss.
pub struct TransportRequestProof {
    fence: ExecutionFence,
    request_id: String,
    receipt_id: String,
}

impl TransportInvocation {
    pub fn input(&self) -> &SubmissionInput {
        &self.input
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn into_process(self) -> (SubmissionInput, ConnectionLaunchPermit) {
        (self.input, self.permit)
    }

    /// Cancellation, body reads, Gateway reconciliation and socket close must
    /// all be inside `request`. Dropping this future produces no proof.
    pub async fn settle<F: Future>(self, request: F) -> (F::Output, TransportRequestProof) {
        let output = request.await;
        drop(self.permit);
        (
            output,
            TransportRequestProof {
                fence: self.fence,
                request_id: self.request_id,
                receipt_id: self.receipt_id,
            },
        )
    }
}

impl TransportRequestProof {
    pub fn matches(&self, fence: &ExecutionFence) -> bool {
        self.fence == *fence
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn connection_receipt_id(&self) -> &str {
        &self.receipt_id
    }
}

pub async fn prepare_transport_invocation(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    permit: ConnectionLaunchPermit,
) -> Result<TransportInvocation> {
    let id = fence.identity();
    if !permit.matches_launch(id.run_id, id.attempt_id, fence.run_execution_owner_token()) {
        return Err(http(409, "Native Chat transport launch ownership changed"));
    }
    let input = submission::load_transport_input(pool, actor, fence).await?;
    let mut tx = pool.begin().await?;
    let locked = context::lock_current_execution(&mut tx, actor, fence).await?;
    submission::revalidate_input(&mut tx, fence, &input).await?;
    if input.checkpoint_revision() != locked.checkpoint.revision() {
        return Err(http(409, "Native Chat transport input changed"));
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let checkpoint = locked
        .checkpoint
        .prepare_transport_input(locked.checkpoint.revision(), request_id.clone())
        .map_err(|_| http(409, "Native Chat transport invocation is not fresh"))?;
    persist_checkpoint(&mut tx, fence, &checkpoint).await?;
    audit_checkpoint(&mut tx, actor, fence, &checkpoint).await?;
    context::lock_current_execution(&mut tx, actor, fence).await?;
    crate::native_chat::auth::authorize_execution_org(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(TransportInvocation {
        fence: fence.clone(),
        input,
        permit,
        request_id,
        receipt_id: uuid::Uuid::new_v4().to_string(),
    })
}

/// Records the actual provider session only after the owned transport returned.
/// A stateless invocation leaves the Segment locator absent.
pub async fn record_transport_terminal(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    request_id: &str,
    session: Option<&str>,
    stop: Option<&StopIntent>,
) -> Result<super::CheckpointSnapshot> {
    let mut tx = pool.begin().await?;
    let locked = if let Some(stop) = stop {
        context::lock_stopping_execution(&mut tx, actor, fence, stop).await?
    } else {
        context::lock_current_execution(&mut tx, actor, fence).await?
    };
    if locked
        .native_session_id
        .as_deref()
        .is_some_and(|old| session.is_some_and(|new| old != new))
    {
        return Err(http(409, "Native Chat transport session changed"));
    }
    let checkpoint = locked
        .checkpoint
        .record_transport_terminal(
            locked.checkpoint.revision(),
            request_id,
            session.map(str::to_owned),
        )
        .map_err(|_| {
            http(
                409,
                "Native Chat transport terminal does not match invocation",
            )
        })?;
    persist_checkpoint(&mut tx, fence, &checkpoint).await?;
    if locked.native_session_id.is_none()
        && let Some(session) = session
    {
        let changed = sqlx::query("UPDATE native_segments SET native_session_id=$3,state='open',updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND state='pending' AND native_session_id IS NULL AND sealed_at IS NULL")
            .bind(fence.identity().organization_id).bind(&locked.segment_id).bind(session).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(http(409, "Native Chat transport Segment changed"));
        }
    }
    audit_checkpoint(&mut tx, actor, fence, &checkpoint).await?;
    if let Some(stop) = stop {
        context::lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    } else {
        context::lock_current_execution(&mut tx, actor, fence).await?;
    }
    crate::native_chat::auth::authorize_execution_org(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(super::checkpoint::snapshot(&checkpoint))
}

async fn persist_checkpoint(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    fence: &ExecutionFence,
    checkpoint: &NativeChatProtocolCheckpoint,
) -> Result<()> {
    sqlx::query("SELECT set_config('rudder.native_chat_write',$1,true)")
        .bind(super::NATIVE_WRITE_MARKER)
        .execute(&mut **tx)
        .await?;
    let id = fence.identity();
    let encoded = serde_json::to_value(checkpoint)
        .map_err(|_| http(500, "Native Chat transport checkpoint cannot be encoded"))?;
    let changed = sqlx::query("UPDATE heartbeat_run_attempts SET checkpoint_json=$5,protocol_phase=$6 WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid AND owner_token=$4 AND status='started' AND attempt_epoch=$7 AND generation_attempt_epoch=$8 AND connection_epoch=$9 AND checkpoint_json->>'revision'=$10")
        .bind(id.organization_id).bind(id.run_id).bind(id.attempt_id).bind(fence.run_execution_owner_token()).bind(encoded).bind(checkpoint.phase().as_str()).bind(id.run_attempt_epoch).bind(id.generation_attempt_epoch).bind(id.connection_epoch).bind((checkpoint.revision()-1).to_string()).execute(&mut **tx).await?.rows_affected();
    if changed != 1 {
        return Err(http(409, "Native Chat transport Attempt ownership changed"));
    }
    Ok(())
}

async fn audit_checkpoint(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    checkpoint: &NativeChatProtocolCheckpoint,
) -> Result<()> {
    use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
    let id = fence.identity();
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(id.run_id.into()),
    };
    let details = serde_json::json!({"conversationId":id.conversation_id,"generationId":id.generation_id,"runId":id.run_id,"attemptId":id.attempt_id,"phase":checkpoint.phase().as_str(),"revision":checkpoint.revision()});
    write_activity_options(
        tx,
        ActivityWrite {
            org: id.organization_id,
            audit: &audit,
            action: "runtime.native_chat.checkpoint_advanced",
            entity_type: "chat_generation",
            entity_id: id.generation_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(id.agent_id),
                bind_run: true,
                ..ActivityOptions::default()
            },
        },
    )
    .await?;
    Ok(())
}
