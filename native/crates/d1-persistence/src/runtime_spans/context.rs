use crate::runtime_bindings;
use rudder_auth_core::VerifiedActor;
use sqlx::{Postgres, Row, Transaction};

use super::validation::{Result, canonical_uuid, http};

pub(super) struct LockedContext {
    pub(super) run_id: String,
    pub(super) attempt_id: String,
    pub(super) attempt_index: i32,
    pub(super) attempt_epoch: i32,
    pub(super) owner_token: String,
    pub(super) binding_id: String,
    pub(super) segment_id: String,
    pub(super) native_session_id: Option<String>,
    pub(super) root_session_id: Option<String>,
    pub(super) leaf_id: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) struct CurrentContextInput<'a> {
    pub(super) organization_id: &'a str,
    pub(super) run_id: &'a str,
    pub(super) attempt_id: &'a str,
    pub(super) attempt_epoch: i32,
    pub(super) owner_token: &'a str,
    pub(super) binding_id: &'a str,
    pub(super) segment_id: &'a str,
}

pub(super) async fn lock_current_context(
    tx: &mut Transaction<'_, Postgres>,
    actor: &VerifiedActor,
    input: &CurrentContextInput<'_>,
) -> Result<LockedContext> {
    lock_current_context_inner(tx, actor, input, false).await
}

/// Lock the same fenced Run/Attempt/Binding/Segment context for a terminal
/// lifecycle operation. A segment that was already sealed is a valid target
/// for an idempotent close/reconciliation retry.
pub(super) async fn lock_current_context_allow_sealed_segment(
    tx: &mut Transaction<'_, Postgres>,
    actor: &VerifiedActor,
    input: &CurrentContextInput<'_>,
) -> Result<LockedContext> {
    lock_current_context_inner(tx, actor, input, true).await
}

async fn lock_current_context_inner(
    tx: &mut Transaction<'_, Postgres>,
    actor: &VerifiedActor,
    input: &CurrentContextInput<'_>,
    allow_sealed_segment: bool,
) -> Result<LockedContext> {
    let CurrentContextInput {
        organization_id,
        run_id,
        attempt_id,
        attempt_epoch,
        owner_token,
        binding_id,
        segment_id,
    } = *input;
    if attempt_epoch <= 0 {
        return Err(http(409, "Run attempt epoch is stale"));
    }
    // Read the immutable association first, then lock Conversation before Run.
    // Side Chat destroy follows this order before its Run FK effects.
    let hint = sqlx::query(
        "SELECT agent_id::text AS agent_id,
                chat_conversation_id::text AS conversation_id
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run not found"))?;

    let hinted_agent_id: String = hint.try_get("agent_id")?;
    let hinted_conversation_id: Option<String> = hint.try_get("conversation_id")?;
    let hinted_conversation_id =
        hinted_conversation_id.ok_or_else(|| http(409, "Run is not attached to Chat"))?;
    runtime_bindings::authorize_chat_target_run_mutation_tx(
        tx,
        actor,
        organization_id,
        &hinted_conversation_id,
        &hinted_agent_id,
        run_id,
    )
    .await?;

    let run = sqlx::query(
        "SELECT id::text AS run_id, agent_id::text AS agent_id,
                chat_conversation_id::text AS conversation_id, status,
                execution_owner_token
         FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run not found"))?;

    let run_id: String = run.try_get("run_id")?;
    let agent_id: String = run.try_get("agent_id")?;
    let conversation_id: Option<String> = run.try_get("conversation_id")?;
    let conversation_id =
        conversation_id.ok_or_else(|| http(409, "Run is not attached to Chat"))?;
    let run_status: String = run.try_get("status")?;
    let run_owner: Option<String> = run.try_get("execution_owner_token")?;
    if agent_id != hinted_agent_id || conversation_id != hinted_conversation_id {
        return Err(http(409, "Run Chat association changed"));
    }
    // Recheck under both locks so the TTL admission test uses the locked Run.
    let principal_scope_ref = runtime_bindings::authorize_chat_target_run_mutation_tx(
        tx,
        actor,
        organization_id,
        &conversation_id,
        &agent_id,
        &run_id,
    )
    .await?;

    let terminal_retry = allow_sealed_segment
        && matches!(
            run_status.as_str(),
            "succeeded" | "failed" | "cancelled" | "timed_out"
        )
        && run_owner.as_deref() == Some(owner_token);
    if (run_status != "running" && !terminal_retry) || run_owner.as_deref() != Some(owner_token) {
        return Err(http(409, "Run execution owner or lease is stale"));
    }

    let agent_runtime_type = sqlx::query_scalar::<_, String>(
        "SELECT agent_runtime_type FROM agents
         WHERE org_id=$1::uuid AND id=$2::uuid
           AND status NOT IN ('terminated','pending_approval')",
    )
    .bind(organization_id)
    .bind(&agent_id)
    .fetch_optional(&mut **tx)
    .await?;
    let agent_runtime_type =
        agent_runtime_type.ok_or_else(|| http(409, "Run Agent is not available"))?;

    let attempt = sqlx::query(
        "SELECT id::text AS attempt_id, agent_id::text AS agent_id,
                attempt_index, attempt_epoch, owner_token, runtime_type, status
         FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(&run_id)
    .bind(attempt_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run attempt not found"))?;

    let stored_attempt_id: String = attempt.try_get("attempt_id")?;
    let attempt_agent_id: String = attempt.try_get("agent_id")?;
    let attempt_index: i32 = attempt.try_get("attempt_index")?;
    let stored_epoch: Option<i32> = attempt.try_get("attempt_epoch")?;
    let stored_owner: Option<String> = attempt.try_get("owner_token")?;
    let attempt_runtime_type: String = attempt.try_get("runtime_type")?;
    let attempt_status: String = attempt.try_get("status")?;
    if attempt_agent_id != agent_id
        || stored_epoch != Some(attempt_epoch)
        || stored_owner.as_deref() != Some(owner_token)
        || (!terminal_retry
            && !matches!(attempt_status.as_str(), "started" | "waiting_for_network"))
        || attempt_index < 0
    {
        return Err(http(409, "Run attempt owner or epoch is stale"));
    }

    // The immediate heartbeat_run_attempts.run_id FK takes KEY SHARE on the
    // Run row. Our Run FOR UPDATE lock prevents a newer attempt insert from
    // committing between this current-attempt check and the span transaction.
    let has_newer_attempt: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM heartbeat_run_attempts
           WHERE org_id=$1::uuid AND run_id=$2::uuid AND attempt_index > $3
         )",
    )
    .bind(organization_id)
    .bind(&run_id)
    .bind(attempt_index)
    .fetch_one(&mut **tx)
    .await?;
    if has_newer_attempt {
        return Err(http(409, "Run attempt is no longer current"));
    }

    let binding_id = canonical_uuid(binding_id, "binding id")?;
    let segment_id = canonical_uuid(segment_id, "segment id")?;
    let bound = sqlx::query(
        "SELECT b.agent_id::text AS binding_agent_id,
                b.conversation_id::text AS binding_conversation_id,
                b.target_type, b.target_id, b.runtime_type, b.principal_scope_ref,
                b.current_segment_id::text AS current_segment_id, b.status AS binding_status,
                s.id::text AS segment_id, s.runtime_type AS segment_runtime_type,
                s.state AS segment_state, s.native_session_id, s.root_session_id, s.leaf_id
         FROM runtime_bindings b
         JOIN native_segments s ON s.org_id=b.org_id AND s.binding_id=b.id
         WHERE b.org_id=$1::uuid AND b.id=$2::uuid AND s.id=$3::uuid
         FOR UPDATE OF b, s",
    )
    .bind(organization_id)
    .bind(&binding_id)
    .bind(&segment_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Runtime binding segment not found"))?;

    let binding_agent_id: String = bound.try_get("binding_agent_id")?;
    let binding_conversation_id: Option<String> = bound.try_get("binding_conversation_id")?;
    let target_type: Option<String> = bound.try_get("target_type")?;
    let target_id: Option<String> = bound.try_get("target_id")?;
    let runtime_type: String = bound.try_get("runtime_type")?;
    let binding_scope: String = bound.try_get("principal_scope_ref")?;
    let current_segment_id: Option<String> = bound.try_get("current_segment_id")?;
    let binding_status: String = bound.try_get("binding_status")?;
    let stored_segment_id: String = bound.try_get("segment_id")?;
    let segment_runtime_type: String = bound.try_get("segment_runtime_type")?;
    let segment_state: String = bound.try_get("segment_state")?;
    let native_session_id: Option<String> = bound.try_get("native_session_id")?;
    let root_session_id: Option<String> = bound.try_get("root_session_id")?;
    let leaf_id: Option<String> = bound.try_get("leaf_id")?;

    if binding_agent_id != agent_id
        || binding_conversation_id.as_deref() != Some(conversation_id.as_str())
        || target_type.as_deref() != Some("chat_conversation")
        || target_id.as_deref() != Some(conversation_id.as_str())
        || current_segment_id.as_deref() != Some(segment_id.as_str())
        || binding_status != "active"
        || binding_scope != principal_scope_ref
        || runtime_type != agent_runtime_type
        || runtime_type != attempt_runtime_type
        || segment_runtime_type != runtime_type
        || (!allow_sealed_segment && !matches!(segment_state.as_str(), "pending" | "open"))
        || (allow_sealed_segment
            && !matches!(segment_state.as_str(), "pending" | "open" | "sealed"))
    {
        return Err(http(409, "Run, binding, and current segment do not match"));
    }
    if !terminal_retry {
        assert_current_lease_tx(tx, organization_id, &run_id, owner_token).await?;
    }

    Ok(LockedContext {
        run_id,
        attempt_id: stored_attempt_id,
        attempt_index,
        attempt_epoch,
        owner_token: owner_token.to_owned(),
        binding_id,
        segment_id: stored_segment_id,
        native_session_id,
        root_session_id,
        leaf_id,
    })
}

pub(super) async fn assert_current_lease_tx(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    run_id: &str,
    owner_token: &str,
) -> Result<()> {
    let valid: bool = sqlx::query_scalar(
        "SELECT status='running' AND execution_owner_token=$3
                AND COALESCE(execution_lease_expires_at > clock_timestamp(), false)
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(run_id)
    .bind(owner_token)
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or(false);
    if valid {
        Ok(())
    } else {
        Err(http(409, "Run execution owner or lease is stale"))
    }
}
