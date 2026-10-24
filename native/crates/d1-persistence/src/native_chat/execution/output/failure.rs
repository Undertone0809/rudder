//! Preserve an authenticated committed prefix when an owned Codex execution
//! fails before a provider terminal receipt. This never synthesizes an answer.
use super::*;

pub(in crate::native_chat::execution) async fn fail_existing_projection(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    fence: &ExecutionFence,
    cleanup: &rudder_codex_app_server::CleanupReceipt,
) -> Result<Option<String>> {
    let id = fence.identity();
    let messages = sqlx::query(
        "SELECT m.id::text,m.status,m.kind,m.replying_agent_id::text AS replying_agent_id,
          m.chat_turn_id::text AS chat_turn_id,m.turn_variant,
          s.chat_turn_id::text AS source_turn_id,s.turn_variant AS source_turn_variant,
          CASE WHEN octet_length(m.body)<=$4 THEN m.body END AS body,
          (m.structured_payload IS NULL OR m.structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS plain
         FROM chat_messages m
         JOIN chat_generations g ON g.org_id=m.org_id AND g.id=$5::uuid
           AND g.conversation_id=m.conversation_id
         JOIN chat_messages s ON s.org_id=g.org_id AND s.id=g.source_message_id
         WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
           AND m.run_id=$3::uuid AND m.role='assistant'
         ORDER BY m.id LIMIT 2 FOR UPDATE OF m",
    )
    .bind(id.organization_id)
    .bind(id.conversation_id)
    .bind(id.run_id)
    .bind(MAX_BODY_BYTES as i32)
    .bind(id.generation_id)
    .fetch_all(&mut **tx)
    .await?;
    if messages.len() > 1 {
        return Err(http(409, "Native Chat assistant projection is ambiguous"));
    }
    let Some(message) = messages.first() else {
        let has_output: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chat_generation_events
             WHERE org_id=$1::uuid AND generation_id=$2::uuid AND run_id=$3::uuid
               AND event_kind IN ('assistant_delta','runtime_output'))",
        )
        .bind(id.organization_id)
        .bind(id.generation_id)
        .bind(id.run_id)
        .fetch_one(&mut **tx)
        .await?;
        if has_output {
            return Err(http(409, "Native Chat assistant projection is missing"));
        }
        return Ok(None);
    };
    let message_id: String = message.try_get("id")?;
    let body: String = message
        .try_get::<Option<String>, _>("body")?
        .ok_or_else(|| http(409, "Native Chat assistant projection exceeds its bound"))?;
    if message.try_get::<String, _>("status")? != "streaming"
        || message.try_get::<String, _>("kind")? != "message"
        || message
            .try_get::<Option<String>, _>("replying_agent_id")?
            .as_deref()
            != Some(id.agent_id)
        || message.try_get::<Option<String>, _>("chat_turn_id")?
            != message.try_get::<Option<String>, _>("source_turn_id")?
        || message.try_get::<i32, _>("turn_variant")?
            != message.try_get::<i32, _>("source_turn_variant")?
        || !message.try_get::<bool, _>("plain")?
    {
        return Err(http(409, "Native Chat assistant projection changed"));
    }
    validate_projection(
        tx,
        fence,
        cleanup,
        &message_id,
        &body,
        NativeChatProtocolPhase::TurnKnown,
    )
    .await?;
    let updated = sqlx::query(
        "UPDATE chat_messages SET status='failed',updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid
           AND run_id=$4::uuid AND role='assistant' AND status='streaming'",
    )
    .bind(id.organization_id)
    .bind(id.conversation_id)
    .bind(&message_id)
    .bind(id.run_id)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(http(409, "Native Chat assistant projection changed"));
    }
    Ok(Some(message_id))
}
