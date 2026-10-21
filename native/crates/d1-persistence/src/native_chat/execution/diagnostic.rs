use super::{ExecutionFence, Result, context::lock_current_execution, http};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::native_chat::NativeChatExecutionActor;
use serde_json::json;
use sqlx::PgPool;

/// Record a bounded internal classification while the exact owner fence is
/// still live. This is evidence only: no status, checkpoint, hold, lease or
/// provider state changes, and no provider payload or owner capability is logged.
pub async fn record_execution_diagnostic(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    code: &'static str,
    process_quiescent: bool,
) -> Result<()> {
    if code.is_empty()
        || code.len() > 64
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return Err(http(400, "Invalid Native Chat diagnostic classification"));
    }
    let mut tx = pool.begin().await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    let details = json!({
        "conversationId": fence.conversation_id,
        "generationId": fence.generation_id,
        "runId": fence.run_id,
        "attemptId": fence.attempt_id,
        "code": code,
        "processQuiescent": process_quiescent,
    });
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(fence.run_id.clone()),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: &fence.organization_id,
            audit: &audit,
            action: "runtime.native_chat.execution_unresolved",
            entity_type: "chat_generation",
            entity_id: &fence.generation_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(&locked.agent_id),
                bind_run: true,
                ..ActivityOptions::default()
            },
        },
    )
    .await?;
    // The audit may block. Reauthorize both owners and their leases before
    // committing rather than letting an expired owner append evidence later.
    lock_current_execution(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(())
}
