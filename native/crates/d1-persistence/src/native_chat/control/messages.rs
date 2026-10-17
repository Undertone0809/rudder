//! Bounded, authorized message projection for the public NDJSON adapter.
//! Provider locators, private output provenance and execution capabilities never
//! enter this DTO. Reading an admitted turn never dispatches or resumes it.
use super::*;
use serde_json::Value;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadTurn {
    pub conversation_id: String,
    pub generation_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnView {
    pub generation_id: String,
    pub run_id: String,
    pub source_message: Value,
    pub assistant_message: Option<Value>,
    pub generation_status: String,
    pub run_status: String,
    /// Whether the Generation owner lease appears live at the read snapshot.
    /// `None` means the persisted owner/lease pair is malformed and callers
    /// must fail closed. This does not expose owner tokens or provider locators.
    pub execution_owner_live: Option<bool>,
    pub attempt_epoch: i32,
    pub control_version: i32,
    pub runtime_terminal: bool,
    pub native_admission_hold: bool,
    pub last_sequence: i32,
}

pub async fn read_turn(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &ReadTurn,
) -> Result<TurnView> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    let org = actor.organization_id();
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    let target = target(
        &mut tx,
        actor,
        &request.conversation_id,
        &request.generation_id,
    )
    .await?;
    let generation = sqlx::query(
        "SELECT source_message_id::text,status,attempt_epoch,control_version,
           runtime_terminal_at IS NOT NULL AS terminal,native_admission_hold,
           CASE
             WHEN g.runtime_terminal_at IS NOT NULL AND g.control_lease_expires_at IS NULL THEN false
             WHEN g.control_owner_token IS NULL AND g.control_lease_expires_at IS NULL THEN false
             WHEN g.control_owner_token IS NOT NULL
              AND g.control_lease_expires_at > statement_timestamp() THEN true
             WHEN g.control_owner_token IS NOT NULL
              AND g.control_lease_expires_at IS NOT NULL THEN false
             ELSE NULL
           END AS execution_owner_live,
           (SELECT r.status FROM heartbeat_runs r
             WHERE r.org_id=g.org_id AND r.id=$4::uuid) AS run_status,
           (SELECT COALESCE(max(generation_seq),0) FROM chat_generation_events e
             WHERE e.org_id=g.org_id AND e.generation_id=g.id) AS last_sequence
         FROM chat_generations g WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND id=$3::uuid AND execution_authority='native_rust'",
    )
    .bind(org)
    .bind(&request.conversation_id)
    .bind(&request.generation_id)
    .bind(&target.run_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat generation not found"))?;
    let source_id: String = generation.try_get("source_message_id")?;
    let rows = sqlx::query(
        "SELECT m.id::text,m.role,m.kind,m.status,
          (m.structured_payload IS NULL OR m.structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS plain,
          m.approval_id IS NULL AS no_approval,
          NOT EXISTS(SELECT 1 FROM chat_attachments a WHERE a.org_id=m.org_id AND a.message_id=m.id) AS no_attachments,
          CASE WHEN octet_length(m.body)<=262144 THEN jsonb_build_object(
            'id',m.id,'orgId',m.org_id,'conversationId',m.conversation_id,
            'role',m.role,'kind',m.kind,'status',m.status,'body',m.body,
            'structuredPayload',NULL,'approvalId',NULL,'approval',NULL,'attachments','[]'::jsonb,
            'runId',m.run_id,'generationId',$5::text,'replyingAgentId',m.replying_agent_id,
            'chatTurnId',m.chat_turn_id,'turnVariant',m.turn_variant,'supersededAt',m.superseded_at,
            'createdAt',m.created_at,'updatedAt',m.updated_at) END AS message
         FROM chat_messages m WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
           AND (m.id=$3::uuid OR (m.run_id=$4::uuid AND m.role='assistant'))
         ORDER BY (m.id=$3::uuid) DESC,m.id LIMIT 3",
    ).bind(org).bind(&request.conversation_id).bind(&source_id).bind(&target.run_id)
        .bind(&request.generation_id).fetch_all(&mut *tx).await?;
    if rows.is_empty() || rows.len() > 2 {
        return Err(http(
            409,
            "Native Chat message projection is missing or ambiguous",
        ));
    }
    let mut source = None;
    let mut assistant = None;
    for row in rows {
        let id: String = row.try_get("id")?;
        let role: String = row.try_get("role")?;
        let status: String = row.try_get("status")?;
        if row.try_get::<String, _>("kind")? != "message"
            || !row.try_get::<bool, _>("plain")?
            || !row.try_get::<bool, _>("no_approval")?
            || !row.try_get::<bool, _>("no_attachments")?
            || !matches!(
                status.as_str(),
                "streaming" | "completed" | "stopped" | "failed" | "interrupted"
            )
        {
            return Err(http(
                409,
                "Native Chat message requires an unsupported projection",
            ));
        }
        let message: Value = row
            .try_get::<Option<Value>, _>("message")?
            .ok_or_else(|| http(422, "Native Chat message exceeds the read bound"))?;
        if id == source_id && role == "user" {
            source = Some(message);
        } else if role == "assistant" && assistant.is_none() {
            assistant = Some(message);
        } else {
            return Err(http(409, "Native Chat message association changed"));
        }
    }
    let view = TurnView {
        generation_id: request.generation_id.clone(),
        run_id: target.run_id,
        source_message: source.ok_or_else(|| http(409, "Native Chat source message is missing"))?,
        assistant_message: assistant,
        generation_status: generation.try_get("status")?,
        run_status: generation.try_get("run_status")?,
        execution_owner_live: generation.try_get("execution_owner_live")?,
        attempt_epoch: generation.try_get("attempt_epoch")?,
        control_version: generation.try_get("control_version")?,
        runtime_terminal: generation.try_get("terminal")?,
        native_admission_hold: generation.try_get("native_admission_hold")?,
        last_sequence: generation.try_get("last_sequence")?,
    };
    auth::preauthorize_org(&mut tx, actor, org).await?;
    tx.commit().await?;
    Ok(view)
}
