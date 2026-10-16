//! Load only the admitted user input under the current execution fence.
//! No conversation history or caller-supplied replacement enters this path.

use super::{ExecutionFence, Result, context::lock_current_execution, http};
use crate::native_chat::validation;
use rudder_auth_core::VerifiedActor;
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use sqlx::{PgPool, Row};

/// Sensitive, read-only input. This is not an effect permit and deliberately
/// implements neither Debug nor serialization. Dispatch still requires a fresh
/// committed SubmitInput permit for the same Attempt and predecessor revision.
pub struct SubmissionInput {
    message_id: String,
    body: String,
    run_id: String,
    attempt_id: String,
    checkpoint_revision: u64,
}

impl SubmissionInput {
    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn checkpoint_revision(&self) -> u64 {
        self.checkpoint_revision
    }
}

/// Read the original input only before submission. Restored indeterminate or
/// later checkpoints cannot obtain a new send payload from this API.
pub async fn load_submission(
    pool: &PgPool,
    actor: &VerifiedActor,
    fence: &ExecutionFence,
) -> Result<SubmissionInput> {
    let mut tx = pool.begin().await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    if locked.checkpoint.phase() != NativeChatProtocolPhase::InputPreSubmission {
        return Err(http(
            409,
            "Native Chat input is not awaiting first submission",
        ));
    }
    let row = sqlx::query(
        "SELECT m.id::text AS message_id,
                CASE WHEN octet_length(m.body) <= 80000 THEN m.body END AS body,
                m.client_mutation_fingerprint,
                r.context_snapshot->>'inputFingerprint' AS admitted_fingerprint,
                r.context_snapshot->>'userMessageId' AS admitted_message_id
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN chat_messages m ON m.org_id=g.org_id AND m.id=g.source_message_id
           AND m.conversation_id=g.conversation_id AND m.run_id=r.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND g.id=$3::uuid
           AND m.role='user' AND m.kind='message' AND m.status='completed'
           AND m.turn_variant=g.source_turn_variant
         FOR SHARE OF m NOWAIT",
    )
    .bind(&fence.organization_id)
    .bind(&fence.run_id)
    .bind(&fence.generation_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| match error {
        sqlx::Error::Database(ref database) if database.code().as_deref() == Some("55P03") => {
            http(409, "Native Chat source input is being changed")
        }
        other => other.into(),
    })?
    .ok_or_else(|| http(409, "Native Chat source input is unavailable"))?;
    let message_id: String = row.try_get("message_id")?;
    let body: Option<String> = row.try_get("body")?;
    let body = body.ok_or_else(|| http(409, "Native Chat source input exceeds its bound"))?;
    let normalized =
        validation::body(&body).map_err(|_| http(409, "Native Chat source input is invalid"))?;
    let fingerprint = validation::fingerprint(&body);
    let source_fingerprint: Option<String> = row.try_get("client_mutation_fingerprint")?;
    let admitted_fingerprint: Option<String> = row.try_get("admitted_fingerprint")?;
    let admitted_message_id: Option<String> = row.try_get("admitted_message_id")?;
    if body != normalized
        || source_fingerprint.as_deref() != Some(fingerprint.as_str())
        || admitted_fingerprint.as_deref() != Some(fingerprint.as_str())
        || admitted_message_id.as_deref() != Some(message_id.as_str())
    {
        return Err(http(
            409,
            "Native Chat source input changed after admission",
        ));
    }
    // Recheck after the source-row wait: a blocked reader must not return a
    // payload after the owner lease expires.
    lock_current_execution(&mut tx, actor, fence).await?;
    let input = SubmissionInput {
        message_id,
        body,
        run_id: fence.run_id.clone(),
        attempt_id: fence.attempt_id.clone(),
        checkpoint_revision: locked.checkpoint.revision(),
    };
    tx.commit().await?;
    Ok(input)
}
