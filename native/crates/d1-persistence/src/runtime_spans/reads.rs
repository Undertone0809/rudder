use rudder_auth_core::VerifiedActor;
use serde_json::Value;
use sqlx::{PgPool, Row};

use crate::runtime_bindings;

use super::projection::span_and_segment;
use super::validation::{Result, canonical_uuid, http};

pub(super) async fn read(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    raw_span_id: &str,
) -> Result<Value> {
    let span_id = canonical_uuid(raw_span_id, "span id")?;
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        "SELECT s.id::text AS span_id, s.binding_id::text AS binding_id,
                s.segment_id::text AS segment_id, b.agent_id::text AS agent_id,
                b.conversation_id::text AS conversation_id, b.target_type, b.target_id,
                b.principal_scope_ref
         FROM run_runtime_spans s
         JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
         WHERE s.org_id=$1::uuid AND s.id=$2::uuid",
    )
    .bind(organization_id)
    .bind(&span_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run span not found"))?;

    let binding_id: String = row.try_get("binding_id")?;
    let segment_id: String = row.try_get("segment_id")?;
    let agent_id: String = row.try_get("agent_id")?;
    let target_type: Option<String> = row.try_get("target_type")?;
    let target_id: String = row.try_get("target_id")?;
    let conversation_id: Option<String> = row.try_get("conversation_id")?;
    let binding_scope: String = row.try_get("principal_scope_ref")?;
    if target_type.as_deref() != Some("chat_conversation")
        || conversation_id.as_deref() != Some(target_id.as_str())
    {
        return Err(http(404, "Run span not found"));
    }

    let principal_scope_ref = runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        organization_id,
        &target_id,
        &agent_id,
    )
    .await?;
    if binding_scope != principal_scope_ref {
        return Err(http(404, "Run span not found"));
    }
    let result =
        span_and_segment(&mut tx, organization_id, &span_id, &binding_id, &segment_id).await?;
    tx.commit().await?;
    Ok(result)
}
