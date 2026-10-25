//! Durable recovery discovery, independent of the active-generation queue.
use super::*;

const OWNER_LOSS_CODE: &str = "native_chat_owner_lost_cleanup_unknown";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryView {
    pub execution_authority: &'static str,
    pub org_id: String,
    pub conversation_id: String,
    pub recovery: Option<UnverifiedCleanup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnverifiedCleanup {
    pub generation_id: String,
    pub run_id: String,
    pub attempt_epoch: i32,
    pub generation_status: &'static str,
    pub control_state: &'static str,
    pub cleanup_state: &'static str,
}

/// Discover an unresolved owner-loss incident without treating it as active
/// work, claiming execution, or depending on an in-memory transport registry.
pub async fn read_recovery_state(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    conversation_id: &str,
) -> Result<RecoveryView> {
    let org = actor.organization_id();
    canonical_id(org, "organization id")?;
    canonical_id(conversation_id, "conversation id")?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    auth::preauthorize_org(&mut tx, actor, org).await?;

    let row = sqlx::query(
        "SELECT g.id::text AS generation_id,g.attempt_epoch,g.native_admission_hold AS generation_hold,
                g.runtime_terminal_at IS NULL AS no_runtime_terminal,
                g.completed_at IS NULL AS not_completed,
                r.id::text AS run_id,r.agent_id::text AS agent_id,r.status AS run_status,
                r.error_code,r.native_admission_hold AS run_hold,
                r.process_exited_at IS NULL AS process_exit_unknown
         FROM chat_generations g
         JOIN chat_conversations c ON c.org_id=g.org_id AND c.id=g.conversation_id
         LEFT JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
              AND r.chat_conversation_id=g.conversation_id AND r.execution_authority='native_rust'
              AND r.scene='chat' AND r.target_type='chat_conversation' AND r.target_id=c.id::text
         WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid AND c.conversation_kind='chat'
           AND g.execution_authority='native_rust' AND g.status='interrupted_unverified'
           AND g.control_state='control_lost' AND g.terminal_reason=$3
         ORDER BY g.created_at DESC,g.id DESC LIMIT 1",
    )
    .bind(org)
    .bind(conversation_id)
    .bind(OWNER_LOSS_CODE)
    .fetch_optional(&mut *tx)
    .await?;

    let recovery = if let Some(row) = row {
        let agent_id: Option<String> = row.try_get("agent_id")?;
        // Authorize before returning either the incident or an inconsistent-
        // state error. Historical access follows the incident's actual Agent.
        if let Some(agent_id) = agent_id.as_deref() {
            runtime_bindings::preauthorize_chat_target_read_tx(
                &mut tx,
                actor,
                org,
                conversation_id,
                agent_id,
            )
            .await?;
        } else {
            runtime_bindings::authorize_chat_target_read_without_agent_tx(
                &mut tx,
                actor,
                org,
                conversation_id,
            )
            .await?;
        }
        let run_id: Option<String> = row.try_get("run_id")?;
        let epoch: i32 = row.try_get("attempt_epoch")?;
        if !row.try_get::<bool, _>("generation_hold")?
            || row.try_get::<Option<bool>, _>("run_hold")? != Some(true)
            || !row.try_get::<bool, _>("no_runtime_terminal")?
            || !row.try_get::<bool, _>("not_completed")?
            || !row.try_get::<bool, _>("process_exit_unknown")?
            || row.try_get::<Option<String>, _>("run_status")?.as_deref() != Some("failed")
            || row.try_get::<Option<String>, _>("error_code")?.as_deref() != Some(OWNER_LOSS_CODE)
            || epoch < 1
        {
            return Err(http(409, "Native Chat recovery state is inconsistent"));
        }
        Some(UnverifiedCleanup {
            generation_id: row.try_get("generation_id")?,
            run_id: run_id.ok_or_else(|| http(409, "Native Chat recovery Run is missing"))?,
            attempt_epoch: epoch,
            generation_status: "interrupted_unverified",
            control_state: "control_lost",
            cleanup_state: "unknown",
        })
    } else {
        // Even an empty result must enforce organization and private-Chat
        // ownership, including conversations without any selected Agent.
        let selected: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(preferred_agent_id,routed_agent_id)::text
             FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid
               AND conversation_kind='chat'",
        )
        .bind(org)
        .bind(conversation_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
        if let Some(agent) = selected.as_deref() {
            runtime_bindings::preauthorize_chat_target_read_tx(
                &mut tx,
                actor,
                org,
                conversation_id,
                agent,
            )
            .await?;
        } else {
            runtime_bindings::authorize_chat_target_read_without_agent_tx(
                &mut tx,
                actor,
                org,
                conversation_id,
            )
            .await?;
        }
        None
    };
    auth::preauthorize_org(&mut tx, actor, org).await?;
    tx.commit().await?;
    Ok(RecoveryView {
        execution_authority: "native_rust",
        org_id: org.to_owned(),
        conversation_id: conversation_id.to_owned(),
        recovery,
    })
}
