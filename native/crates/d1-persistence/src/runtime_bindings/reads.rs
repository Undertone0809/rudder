use super::{Result, Tx, VerifiedActor, http};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

use super::auth::{
    authorize_conversation, conversation, ensure_conversation_readable, preauthorize_org,
};
use super::projection::{binding_json, segment_json};

pub(super) async fn current(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    conversation_id: &str,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let value = current_tx(&mut tx, actor, organization_id, conversation_id).await?;
    tx.commit().await?;
    Ok(value)
}

pub(super) async fn current_tx(
    tx: &mut Tx<'_>,
    actor: &VerifiedActor,
    organization_id: &str,
    conversation_id: &str,
) -> Result<Value> {
    // Reads share the caller's authorization snapshot and must also work in a
    // READ ONLY transaction; mutation authorization deliberately retains row locks.
    preauthorize_org(tx, actor, organization_id).await?;
    let conversation = conversation(tx, organization_id, conversation_id, false)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    ensure_conversation_readable(&conversation)?;
    let row = sqlx::query(
        "SELECT id::text AS id, agent_id::text AS agent_id,
                current_segment_id::text AS current_segment_id, principal_scope_ref
         FROM runtime_bindings
         WHERE org_id=$1::uuid AND target_type='chat_conversation' AND target_id=$2
               AND status='active'",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?;
    let bound_agent = match &row {
        Some(row) => Some(row.try_get::<String, _>("agent_id")?),
        None => None,
    };
    let scope = authorize_conversation(
        actor,
        organization_id,
        &conversation,
        bound_agent.as_deref(),
    )?;
    let Some(row) = row else {
        return Ok(json!({"binding": null, "segment": null}));
    };
    if row
        .try_get::<Option<String>, _>("principal_scope_ref")?
        .as_deref()
        != Some(scope.as_str())
    {
        return Err(http(404, "Runtime binding not found"));
    }
    let binding_id: String = row.try_get("id")?;
    let segment_id: Option<String> = row.try_get("current_segment_id")?;
    let binding = binding_json(tx, organization_id, &binding_id).await?;
    let segment = match segment_id {
        Some(segment_id) => segment_json(tx, organization_id, &binding_id, &segment_id).await?,
        None => Value::Null,
    };
    Ok(json!({"binding": binding, "segment": segment}))
}

pub(super) async fn read(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    binding_id: &str,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let value = read_tx(&mut tx, actor, organization_id, binding_id).await?;
    tx.commit().await?;
    Ok(value)
}

pub(super) async fn read_tx(
    tx: &mut Tx<'_>,
    actor: &VerifiedActor,
    organization_id: &str,
    binding_id: &str,
) -> Result<Value> {
    // Reads share the caller's authorization snapshot and must also work in a
    // READ ONLY transaction; mutation authorization deliberately retains row locks.
    preauthorize_org(tx, actor, organization_id).await?;
    let row = sqlx::query(
        "SELECT id::text AS id, conversation_id::text AS conversation_id,
                target_type, target_id, agent_id::text AS agent_id,
                current_segment_id::text AS current_segment_id, principal_scope_ref
         FROM runtime_bindings
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(binding_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Runtime binding not found"))?;
    let target_type: Option<String> = row.try_get("target_type")?;
    if target_type.as_deref() != Some("chat_conversation") {
        return Err(http(404, "Runtime binding not found"));
    }
    let conversation_id: Option<String> = row.try_get("conversation_id")?;
    let target_id: String = row.try_get("target_id")?;
    let agent_id: String = row.try_get("agent_id")?;
    if conversation_id.as_deref() != Some(target_id.as_str()) {
        return Err(http(404, "Runtime binding not found"));
    }
    let conversation = conversation(tx, organization_id, &target_id, false)
        .await?
        .ok_or_else(|| http(404, "Runtime binding not found"))?;
    ensure_conversation_readable(&conversation)?;
    let scope = authorize_conversation(actor, organization_id, &conversation, Some(&agent_id))?;
    if row
        .try_get::<Option<String>, _>("principal_scope_ref")?
        .as_deref()
        != Some(scope.as_str())
    {
        return Err(http(404, "Runtime binding not found"));
    }

    let segment_id: Option<String> = row.try_get("current_segment_id")?;
    let binding = binding_json(tx, organization_id, binding_id).await?;
    let segment = match segment_id {
        Some(segment_id) => segment_json(tx, organization_id, binding_id, &segment_id).await?,
        None => Value::Null,
    };
    Ok(json!({"binding": binding, "segment": segment}))
}
