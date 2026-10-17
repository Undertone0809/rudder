use super::{CanonicalIdentity, IdentityInput, Result, VerifiedActor, http};
use crate::native_chat::NativeChatActor;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

use super::auth::{authorize_conversation, authorize_org, conversation};
use super::locks::{lock_binding, lock_target};
use super::projection::{binding_json, binding_matches, segment_json};
use super::validation::{canonical_optional_ref, canonical_ref, canonical_uuid};

pub(super) async fn ensure(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    conversation_id: &str,
    input: &IdentityInput,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let result = ensure_tx(
        &mut tx,
        actor,
        organization_id,
        conversation_id,
        input,
        true,
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}

/// Borrow the caller transaction. The target advisory lock is acquired before
/// Conversation; native admission must acquire it before any other row lock.
pub(super) async fn ensure_tx(
    tx: &mut super::Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    input: &IdentityInput,
    create_if_missing: bool,
) -> Result<Value> {
    let agent_id = canonical_uuid(&input.agent_id, "agent id")?;
    let host_id = canonical_ref(input.host_id.as_deref(), "local", "host id")?;
    let profile_id = canonical_ref(input.profile_id.as_deref(), "default", "profile id")?;
    let workspace_binding_id = canonical_optional_ref(
        input.workspace_binding_id.as_deref(),
        "workspace binding id",
    )?;
    let instructions_revision = canonical_ref(
        input.instructions_revision.as_deref(),
        "unknown",
        "instructions revision",
    )?;
    let capability_revision = canonical_ref(
        input.capability_revision.as_deref(),
        "unknown",
        "capability revision",
    )?;

    lock_target(tx, organization_id, conversation_id).await?;
    authorize_org(tx, actor, organization_id).await?;

    // Re-read and lock the target after waiting for concurrent ensures. The
    // owner and selected-agent facts below therefore belong to this transaction.
    let conversation = conversation(tx, organization_id, conversation_id, true)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let principal_scope_ref =
        authorize_conversation(actor, organization_id, &conversation, Some(&agent_id))?;
    super::auth::ensure_conversation_mutable(&conversation)?;
    if conversation.preferred_agent_id.as_deref() != Some(&agent_id)
        && conversation.routed_agent_id.as_deref() != Some(&agent_id)
    {
        return Err(http(
            409,
            "Agent is not selected for this Chat conversation",
        ));
    }
    let agent = sqlx::query(
        "SELECT agent_runtime_type, status FROM agents
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(&agent_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Agent not found"))?;
    let runtime_type: String = agent.try_get("agent_runtime_type")?;
    let agent_status: String = agent.try_get("status")?;
    if matches!(agent_status.as_str(), "terminated" | "pending_approval") {
        return Err(http(409, "Agent is not available for Chat"));
    }
    let runtime_type = canonical_ref(Some(&runtime_type), "", "agent runtime type")?;

    let identity = CanonicalIdentity {
        agent_id: agent_id.clone(),
        runtime_type,
        host_id,
        profile_id,
        workspace_binding_id,
        instructions_revision,
        capability_revision,
        principal_scope_ref,
    };

    let current = sqlx::query(
        "SELECT id::text AS id, agent_id::text AS agent_id, runtime_type,
                host_id, profile_id, workspace_binding_id, instructions_revision,
                capability_revision, principal_scope_ref, current_segment_id::text AS current_segment_id
         FROM runtime_bindings
         WHERE org_id=$1::uuid AND target_type='chat_conversation' AND target_id=$2
               AND status='active'
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(row) = current {
        let binding_id: String = row.try_get("id")?;
        lock_binding(tx, organization_id, &binding_id).await?;
        // Re-read after acquiring the binding lock so the returned canonical
        // state is current even if a future writer shares this lock protocol.
        let row = sqlx::query(
            "SELECT id::text AS id, agent_id::text AS agent_id, runtime_type,
                    host_id, profile_id, workspace_binding_id, instructions_revision,
                    capability_revision, principal_scope_ref, current_segment_id::text AS current_segment_id
             FROM runtime_bindings
             WHERE org_id=$1::uuid AND id=$2::uuid AND status='active'
             FOR UPDATE",
        )
        .bind(organization_id)
        .bind(&binding_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| http(409, "Runtime binding changed while ensuring Chat"))?;

        if !binding_matches(&row, &identity)? {
            return Err(http(
                409,
                "Chat runtime binding identity conflicts with the active binding",
            ));
        }
        let segment_id: Option<String> = row.try_get("current_segment_id")?;
        let Some(segment_id) = segment_id else {
            return Err(http(
                409,
                "Active Chat runtime binding has no current segment",
            ));
        };
        let binding = binding_json(tx, organization_id, &binding_id).await?;
        let segment = segment_json(tx, organization_id, &binding_id, &segment_id).await?;
        return Ok(json!({"binding": binding, "segment": segment}));
    }

    if !create_if_missing {
        return Err(http(409, "Current Native Chat binding is missing"));
    }

    let binding_id: String = sqlx::query_scalar(
        "INSERT INTO runtime_bindings
           (org_id, conversation_id, target_type, target_id, principal_scope_ref,
            agent_id, runtime_type, host_id, profile_id, workspace_binding_id,
            instructions_revision, capability_revision, continuity, binding_epoch, status)
         VALUES ($1::uuid, $2::uuid, 'chat_conversation', $2::uuid::text, $3, $4::uuid, $5, $6, $7,
                 $8, $9, $10, 'native', 0, 'active')
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(&identity.principal_scope_ref)
    .bind(&identity.agent_id)
    .bind(&identity.runtime_type)
    .bind(&identity.host_id)
    .bind(&identity.profile_id)
    .bind(&identity.workspace_binding_id)
    .bind(&identity.instructions_revision)
    .bind(&identity.capability_revision)
    .fetch_one(&mut **tx)
    .await?;
    lock_binding(tx, organization_id, &binding_id).await?;

    let segment_id: String = sqlx::query_scalar(
        "INSERT INTO native_segments (org_id, binding_id, runtime_type, segment_ordinal, state)
         VALUES ($1::uuid, $2::uuid, $3, 0, 'pending')
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(&binding_id)
    .bind(&identity.runtime_type)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE runtime_bindings
         SET current_segment_id=$3::uuid, updated_at=now()
         WHERE org_id=$1::uuid AND id=$2::uuid AND status='active'",
    )
    .bind(organization_id)
    .bind(&binding_id)
    .bind(&segment_id)
    .execute(&mut **tx)
    .await?;

    let audit = crate::activity::ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: None,
    };
    let details = json!({"targetType":"chat_conversation","bindingId":binding_id});
    crate::activity::write_activity_options(
        tx,
        crate::activity::ActivityWrite {
            org: organization_id,
            audit: &audit,
            action: "runtime.binding.created",
            entity_type: "runtime_binding",
            entity_id: &binding_id,
            details: Some(&details),
            options: crate::activity::ActivityOptions {
                agent_id: (actor.actor().kind == "agent").then_some(actor.actor().id.as_str()),
                bind_run: false,
                ..Default::default()
            },
        },
    )
    .await?;

    let binding = binding_json(tx, organization_id, &binding_id).await?;
    let segment = segment_json(tx, organization_id, &binding_id, &segment_id).await?;
    Ok(json!({"binding": binding, "segment": segment}))
}
