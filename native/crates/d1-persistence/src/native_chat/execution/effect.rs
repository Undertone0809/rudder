//! Short-lived, single-use authorization to enqueue one provider request.
//!
//! This closes the gap between a committed indeterminate checkpoint and the
//! local transport call. It does not make a database commit atomic with an OS
//! write: the caller must dispatch synchronously from the callback, and any
//! transport ambiguity remains indeterminate.

use super::submission::SubmissionInput;
use super::{
    EffectKind, EffectPermit, ExecutionFence, Result, context::lock_current_execution, http,
};
use crate::native_chat::validation;
use rudder_auth_core::VerifiedActor;
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use sqlx::{PgPool, Row};
use std::time::{Duration, Instant};

const MAX_DISPATCH_WINDOW: Duration = Duration::from_secs(2);

/// A provider operation that may be queued synchronously by the trusted local
/// executor. It has no serde or Debug implementation and borrows sensitive
/// input only for the duration of the dispatch callback.
pub enum EffectDispatch<'a> {
    StartThread,
    SubmitInput {
        thread_id: &'a str,
        source_message_id: &'a str,
        body: &'a str,
    },
}

enum Payload {
    StartThread,
    SubmitInput {
        thread_id: String,
        source_message_id: String,
        body: String,
    },
}

/// A move-only authorization whose deadline cannot be extended by time spent
/// checking the database. This type deliberately has no serde or Debug impl.
pub struct AuthorizedEffect {
    deadline: Instant,
    payload: Payload,
}

impl AuthorizedEffect {
    /// Consume this authorization and synchronously hand exactly one payload
    /// to the low-level transport. The deadline check is the final operation
    /// before calling the callback; async work must happen before this method.
    pub fn dispatch<R>(self, callback: impl FnOnce(EffectDispatch<'_>) -> R) -> Result<R> {
        let Self { deadline, payload } = self;
        if Instant::now() >= deadline {
            return Err(http(409, "Native Chat effect authorization expired"));
        }
        let result = match payload {
            Payload::StartThread => callback(EffectDispatch::StartThread),
            Payload::SubmitInput {
                thread_id,
                source_message_id,
                body,
            } => callback(EffectDispatch::SubmitInput {
                thread_id: &thread_id,
                source_message_id: &source_message_id,
                body: &body,
            }),
        };
        Ok(result)
    }
}

/// Revalidate a freshly committed effect permit against the current owner,
/// checkpoint, binding, segment, and admitted input. No restored checkpoint
/// can recreate a permit. Submit consumes the exact pre-submit input value and
/// never loads body text after entering the indeterminate phase.
pub async fn authorize_effect(
    pool: &PgPool,
    actor: &VerifiedActor,
    permit: EffectPermit,
    input: Option<SubmissionInput>,
) -> Result<AuthorizedEffect> {
    // Anchor before any database work so round-trip and commit time use up the
    // same lease-bounded dispatch window instead of extending it.
    let deadline_anchor = Instant::now();
    let fence: &ExecutionFence = &permit.fence;
    let mut tx = pool.begin().await?;
    super::super::budget::lock_policy_state(&mut tx, &fence.organization_id).await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    super::super::budget::ensure_unknown_cost_allowed(
        &mut tx,
        &fence.organization_id,
        &fence.agent_id,
    )
    .await?;
    if locked.checkpoint.phase() != permit.phase
        || locked.checkpoint.revision() != permit.committed_revision()
    {
        return Err(http(409, "Native Chat effect checkpoint is stale"));
    }

    let payload = match (permit.kind(), input) {
        (EffectKind::StartThread, None) => {
            if permit.phase != NativeChatProtocolPhase::ThreadStartIndeterminate
                || permit.thread_id.is_some()
                || permit.source_message_id.is_some()
                || permit.input_fingerprint.is_some()
                || locked.checkpoint.thread_id().is_some()
                || locked.segment_state != "pending"
                || locked.native_session_id.is_some()
            {
                return Err(http(409, "Native Chat Thread start authorization is stale"));
            }
            Payload::StartThread
        }
        (EffectKind::SubmitInput, Some(input)) => {
            let checkpoint_thread = locked
                .checkpoint
                .thread_id()
                .ok_or_else(|| http(409, "Native Chat Thread is unavailable"))?;
            let permit_thread = permit
                .thread_id
                .as_deref()
                .ok_or_else(|| http(409, "Native Chat permit has no Thread identity"))?;
            let source_message_id = permit
                .source_message_id
                .as_deref()
                .ok_or_else(|| http(409, "Native Chat permit has no input identity"))?;
            let input_fingerprint = permit
                .input_fingerprint
                .as_deref()
                .ok_or_else(|| http(409, "Native Chat permit has no input fingerprint"))?;
            if permit.phase != NativeChatProtocolPhase::InputIndeterminate
                || checkpoint_thread != permit_thread
                || locked.segment_state != "open"
                || locked.native_session_id.as_deref() != Some(permit_thread)
                || input.run_id() != fence.run_id.as_str()
                || input.attempt_id() != fence.attempt_id.as_str()
                || input.message_id() != source_message_id
                || input.checkpoint_revision().checked_add(1) != Some(permit.committed_revision())
                || input.fingerprint != input_fingerprint
                || validation::fingerprint(input.body()) != input_fingerprint
                || locked.admitted_message_id.as_deref() != Some(source_message_id)
                || locked.admitted_input_fingerprint.as_deref() != Some(input_fingerprint)
            {
                return Err(http(409, "Native Chat Submit input identity is stale"));
            }

            // Recheck the persisted message identity and mutation fingerprint,
            // while taking a non-waiting row lock. The body remains the exact
            // value loaded before the indeterminate checkpoint.
            let source = sqlx::query(
                "SELECT m.id::text AS message_id, m.client_mutation_fingerprint,
                        m.structured_payload IS NULL AS supported_payload,
                        NOT EXISTS (
                          SELECT 1 FROM chat_attachments ca
                          WHERE ca.org_id=m.org_id AND ca.conversation_id=m.conversation_id
                            AND ca.message_id=m.id
                        ) AS has_no_attachments
                 FROM chat_generations g
                 JOIN chat_messages m ON m.org_id=g.org_id AND m.id=g.source_message_id
                   AND m.conversation_id=g.conversation_id AND m.run_id=$4::uuid
                 WHERE g.org_id=$1::uuid AND g.id=$2::uuid
                   AND g.conversation_id=$3::uuid
                   AND m.role='user' AND m.kind='message' AND m.status='completed'
                   AND m.turn_variant=g.source_turn_variant
                 FOR UPDATE OF m NOWAIT",
            )
            .bind(&fence.organization_id)
            .bind(&fence.generation_id)
            .bind(&fence.conversation_id)
            .bind(&fence.run_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| match error {
                sqlx::Error::Database(ref database)
                    if database.code().as_deref() == Some("55P03") =>
                {
                    http(409, "Native Chat source input is being changed")
                }
                other => other.into(),
            })?
            .ok_or_else(|| http(409, "Native Chat source input is unavailable"))?;
            let stored_message_id: String = source.try_get("message_id")?;
            let stored_fingerprint: Option<String> =
                source.try_get("client_mutation_fingerprint")?;
            let supported_payload: bool = source.try_get("supported_payload")?;
            let has_no_attachments: bool = source.try_get("has_no_attachments")?;
            if stored_message_id != source_message_id
                || stored_fingerprint.as_deref() != Some(input_fingerprint)
                || !supported_payload
                || !has_no_attachments
            {
                return Err(http(
                    409,
                    "Native Chat source input changed or contains unsupported content",
                ));
            }

            Payload::SubmitInput {
                thread_id: permit_thread.to_owned(),
                source_message_id: source_message_id.to_owned(),
                body: input.body().to_owned(),
            }
        }
        _ => {
            return Err(http(
                409,
                "Native Chat effect payload does not match permit",
            ));
        }
    };

    let remaining_ms: Option<i64> = sqlx::query_scalar(
        "WITH db_clock AS (SELECT clock_timestamp() AS now)
         SELECT floor(LEAST(
           EXTRACT(EPOCH FROM (g.control_lease_expires_at - db_clock.now)),
           EXTRACT(EPOCH FROM (r.execution_lease_expires_at - db_clock.now))
         ) * 1000)::bigint
         FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         CROSS JOIN db_clock
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid
           AND g.control_owner_token=$4 AND r.execution_owner_token=$5
           AND g.native_admission_hold=true AND r.native_admission_hold=true
           AND COALESCE(g.control_lease_expires_at > db_clock.now, false)
           AND COALESCE(r.execution_lease_expires_at > db_clock.now, false)",
    )
    .bind(&fence.organization_id)
    .bind(&fence.generation_id)
    .bind(&fence.run_id)
    .bind(&fence.generation_owner_token)
    .bind(&fence.run_owner_token)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let remaining_ms = remaining_ms
        .filter(|remaining| *remaining > 0)
        .ok_or_else(|| http(409, "Native Chat owner lease has expired"))?;
    let dispatch_ms = u64::try_from(remaining_ms)
        .unwrap_or(u64::MAX)
        .min(MAX_DISPATCH_WINDOW.as_millis() as u64);
    if dispatch_ms == 0 {
        return Err(http(409, "Native Chat owner lease has expired"));
    }
    let deadline = deadline_anchor
        .checked_add(Duration::from_millis(dispatch_ms))
        .ok_or_else(|| http(500, "Native Chat dispatch deadline is unavailable"))?;

    tx.commit().await?;
    Ok(AuthorizedEffect { deadline, payload })
}
