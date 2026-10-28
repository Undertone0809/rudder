//! Reuse the existing runtime approval mutation under the Native Chat fence.
use super::{ExecutionFence, Result, context, http};
use crate::{
    agent_execution::{AgentRunObserver, RuntimeApproval},
    native_chat::NativeChatExecutionActor,
};
use serde_json::Value;
use sqlx::{PgPool, Row};

pub async fn create_transport_approval(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    key: &str,
    payload: &Value,
) -> Result<RuntimeApproval> {
    if !payload.is_object() || key.trim().is_empty() {
        return Err(http(422, "Invalid runtime approval request"));
    }
    let mut tx = pool.begin().await?;
    context::lock_current_execution(&mut tx, actor, fence).await?;
    if fence.runtime_type() != "hermes_gateway" {
        return Err(http(
            409,
            "Native Chat runtime does not request Gateway approvals",
        ));
    }
    let id = fence.identity();
    let observer = AgentRunObserver {
        organization_id: id.organization_id.into(),
        agent_id: id.agent_id.into(),
        run_id: id.run_id.into(),
        attempt_id: id.attempt_id.into(),
        owner_token: fence.run_execution_owner_token().into(),
        attempt_epoch: id.run_attempt_epoch,
    };
    let approval = crate::agent_execution::insert_runtime_approval(
        &mut tx,
        &observer,
        fence.runtime_type(),
        key,
        payload,
    )
    .await
    .map_err(|_| http(500, "Native Chat runtime approval could not be recorded"))?;
    context::lock_current_execution(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(approval)
}

pub async fn read_transport_approval(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    approval: &str,
) -> Result<RuntimeApproval> {
    let mut tx = pool.begin().await?;
    context::lock_current_execution(&mut tx, actor, fence).await?;
    let id = fence.identity();
    let row=sqlx::query("SELECT id::text,status FROM approvals WHERE org_id=$1::uuid AND id=$2::uuid AND requested_by_agent_id=$3::uuid AND type='agent_runtime' AND payload->>'runId'=$4 AND payload->>'nativeAttemptId'=$5")
        .bind(id.organization_id).bind(approval).bind(id.agent_id).bind(id.run_id).bind(id.attempt_id).fetch_optional(&mut *tx).await?.ok_or_else(||http(404,"Native Chat runtime approval not found"))?;
    tx.commit().await?;
    Ok(RuntimeApproval {
        id: row.try_get("id")?,
        status: row.try_get("status")?,
    })
}
