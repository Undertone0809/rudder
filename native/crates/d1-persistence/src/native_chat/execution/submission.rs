//! Load only the admitted user input under the current execution fence.
//! No conversation history or caller-supplied replacement enters this path.

use super::{ExecutionFence, Result, context::lock_current_execution, http};
use crate::native_chat::NativeChatExecutionActor;
use crate::native_chat::validation;
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use sqlx::{PgPool, Postgres, Row, Transaction};

/// Sensitive, read-only input. This is not an effect permit and deliberately
/// implements neither Debug nor serialization. Dispatch still requires a fresh
/// committed SubmitInput permit for the same Attempt and predecessor revision.
pub struct SubmissionInput {
    message_id: String,
    body: String,
    run_id: String,
    attempt_id: String,
    checkpoint_revision: u64,
    pub(super) fingerprint: String,
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

    /// Stable digest of the exact admitted UTF-8 body. This is safe to compare
    /// against provider-owned receipts; it does not expose the body itself.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn checkpoint_revision(&self) -> u64 {
        self.checkpoint_revision
    }
}

/// Read the original input only before submission. Restored indeterminate or
/// later checkpoints cannot obtain a new send payload from this API.
pub async fn load_submission(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<SubmissionInput> {
    load(pool, actor, fence, false).await
}

// Private to the one-use combined Claude authorization. The general input
// reader remains strict and cannot return text from a pre-session checkpoint.
pub(super) async fn load_claude_combined_input(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<SubmissionInput> {
    load(pool, actor, fence, true).await
}

async fn load(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    claude_combined: bool,
) -> Result<SubmissionInput> {
    let mut tx = pool.begin().await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    let phase_valid = if claude_combined {
        locked.checkpoint.provider()
            == rudder_runtime_core::native_chat::NativeChatProvider::ClaudeLocal
            && !locked.checkpoint.claude_combined_input()
            && matches!(
                locked.checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest | NativeChatProtocolPhase::ThreadKnown
            )
    } else {
        locked.checkpoint.phase() == NativeChatProtocolPhase::InputPreSubmission
    };
    if !phase_valid {
        return Err(http(
            409,
            "Native Chat input is not awaiting first submission",
        ));
    }
    let source = lock_validated_source(&mut tx, fence).await?;
    // Recheck after the source-row wait: a blocked reader must not return a
    // payload after the owner lease expires.
    lock_current_execution(&mut tx, actor, fence).await?;
    let input = SubmissionInput {
        message_id: source.message_id,
        body: source.body,
        run_id: fence.run_id.clone(),
        attempt_id: fence.attempt_id.clone(),
        checkpoint_revision: locked.checkpoint.revision(),
        fingerprint: source.fingerprint,
    };
    tx.commit().await?;
    Ok(input)
}

pub(super) async fn revalidate_input(
    tx: &mut Transaction<'_, Postgres>,
    fence: &ExecutionFence,
    input: &SubmissionInput,
) -> Result<()> {
    let source = lock_validated_source(tx, fence).await?;
    if source.message_id != input.message_id
        || source.fingerprint != input.fingerprint
        || source.body != input.body
        || input.run_id != fence.run_id
        || input.attempt_id != fence.attempt_id
    {
        return Err(http(409, "Native Chat admitted input changed"));
    }
    Ok(())
}

/// Validate the admitted source before any provider process or Thread effect.
/// This returns no prompt data and is only available before input submission.
/// The executor calls it again immediately before any Thread-start effect;
/// `load_submission` and `authorize_effect` repeat the same checks for Submit.
pub async fn validate_submission_source(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    if !matches!(
        locked.checkpoint.phase(),
        NativeChatProtocolPhase::NoThreadRequest | NativeChatProtocolPhase::ThreadKnown
    ) {
        return Err(http(
            409,
            "Native Chat source validation is no longer before submission",
        ));
    }
    let _source = lock_validated_source(&mut tx, fence).await?;
    lock_current_execution(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(())
}

struct ValidatedSource {
    message_id: String,
    body: String,
    fingerprint: String,
}

async fn lock_validated_source(
    tx: &mut Transaction<'_, Postgres>,
    fence: &ExecutionFence,
) -> Result<ValidatedSource> {
    let row = sqlx::query(
        "SELECT m.id::text AS message_id,
                CASE WHEN octet_length(m.body) <= 80000 THEN m.body END AS body,
                m.client_mutation_fingerprint,
                m.structured_payload IS NULL AS supported_payload,
                NOT EXISTS (
                  SELECT 1 FROM chat_attachments ca
                  WHERE ca.org_id=m.org_id AND ca.conversation_id=m.conversation_id
                    AND ca.message_id=m.id
                ) AS has_no_attachments,
                r.context_snapshot->>'inputFingerprint' AS admitted_fingerprint,
                r.context_snapshot->>'userMessageId' AS admitted_message_id
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN chat_messages m ON m.org_id=g.org_id AND m.id=g.source_message_id
           AND m.conversation_id=g.conversation_id AND m.run_id=r.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND g.id=$3::uuid
           AND m.role='user' AND m.kind='message' AND m.status='completed'
           AND m.turn_variant=g.source_turn_variant
         FOR UPDATE OF m NOWAIT",
    )
    .bind(&fence.organization_id)
    .bind(&fence.run_id)
    .bind(&fence.generation_id)
    .fetch_optional(&mut **tx)
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
    let supported_payload: bool = row.try_get("supported_payload")?;
    let has_no_attachments: bool = row.try_get("has_no_attachments")?;
    let admitted_fingerprint: Option<String> = row.try_get("admitted_fingerprint")?;
    let admitted_message_id: Option<String> = row.try_get("admitted_message_id")?;
    if body != normalized
        || !supported_payload
        || !has_no_attachments
        || source_fingerprint.as_deref() != Some(fingerprint.as_str())
        || admitted_fingerprint.as_deref() != Some(fingerprint.as_str())
        || admitted_message_id.as_deref() != Some(message_id.as_str())
    {
        return Err(http(
            409,
            "Native Chat source input changed or contains unsupported content",
        ));
    }
    Ok(ValidatedSource {
        message_id,
        body,
        fingerprint,
    })
}
