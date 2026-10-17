//! Exact-target authority read for control dispatch. This does not inspect or
//! reconstruct message bodies, mutate state, or authorize a provider effect.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopTargetAuthority {
    NativeRust,
    LegacyTs,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    pub execution_authority: StopTargetAuthority,
    pub org_id: String,
    pub conversation_id: String,
    pub generation_id: String,
    pub attempt_epoch: i32,
    pub control_version: i32,
    pub last_client_checkpoint_seq: Option<i32>,
    pub last_client_checkpoint_hash: Option<String>,
    pub last_sequence: i32,
    pub runtime_terminal: bool,
}

pub async fn read_stop_target_authority(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &ReadTurn,
) -> Result<StopTargetAuthority> {
    Ok(read_control_state(pool, actor, request)
        .await?
        .execution_authority)
}

pub async fn read_control_state(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &ReadTurn,
) -> Result<ControlState> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    let org = actor.organization_id();
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    auth::preauthorize_org(&mut tx, actor, org).await?;
    let row = sqlx::query(
        "SELECT g.execution_authority,g.attempt_epoch,g.control_version,
                g.last_client_checkpoint_seq,g.last_client_checkpoint_hash,
                g.runtime_terminal_at IS NOT NULL AS terminal,
                (SELECT COALESCE(max(generation_seq),0) FROM chat_generation_events e
                 WHERE e.org_id=g.org_id AND e.generation_id=g.id) AS last_sequence,
                COALESCE(c.preferred_agent_id, c.routed_agent_id)::text AS selected_agent_id
         FROM chat_generations g
         JOIN chat_conversations c ON c.org_id=g.org_id AND c.id=g.conversation_id
         WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid AND g.id=$3::uuid
           AND c.conversation_kind='chat'",
    )
    .bind(org)
    .bind(&request.conversation_id)
    .bind(&request.generation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Chat generation not found"))?;
    let authority: String = row.try_get("execution_authority")?;
    let authority = match authority.as_str() {
        "native_rust" => {
            // Native control uses the persisted Run's Agent, including after
            // the conversation has selected a different Agent for future turns.
            target(
                &mut tx,
                actor,
                &request.conversation_id,
                &request.generation_id,
            )
            .await?;
            StopTargetAuthority::NativeRust
        }
        "legacy_ts" => {
            let selected_agent: Option<String> = row.try_get("selected_agent_id")?;
            runtime_bindings::preauthorize_chat_target_read_tx(
                &mut tx,
                actor,
                org,
                &request.conversation_id,
                selected_agent.as_deref().unwrap_or(""),
            )
            .await?;
            StopTargetAuthority::LegacyTs
        }
        _ => return Err(http(409, "Chat generation authority is unsupported")),
    };
    let attempt_epoch: i32 = row.try_get("attempt_epoch")?;
    let control_version: i32 = row.try_get("control_version")?;
    let last_sequence: i32 = row.try_get("last_sequence")?;
    if attempt_epoch < 1 || control_version < 0 || last_sequence < 0 {
        return Err(http(409, "Chat control fence is invalid"));
    }
    let (sequence, hash): (Option<i32>, Option<String>) =
        if authority == StopTargetAuthority::NativeRust {
            (
                row.try_get("last_client_checkpoint_seq")?,
                row.try_get("last_client_checkpoint_hash")?,
            )
        } else {
            (None, None)
        };
    match (&sequence, &hash) {
        (None, None) => (),
        (Some(sequence), Some(hash))
            if *sequence >= 0
                && *sequence <= last_sequence
                && hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) => {}
        _ => return Err(http(409, "Chat control checkpoint is invalid")),
    }
    let state = ControlState {
        execution_authority: authority,
        org_id: org.to_owned(),
        conversation_id: request.conversation_id.clone(),
        generation_id: request.generation_id.clone(),
        attempt_epoch,
        control_version,
        last_client_checkpoint_seq: sequence,
        last_client_checkpoint_hash: hash,
        last_sequence,
        runtime_terminal: row.try_get("terminal")?,
    };
    tx.commit().await?;
    // The read transaction ends before any compatibility HTTP request. The
    // legacy writer must acquire its target lock and recheck Native ownership.
    Ok(state)
}
