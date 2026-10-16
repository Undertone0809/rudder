use super::{CanonicalIdentity, Result, Tx, http};
use serde_json::Value;
use sqlx::Row;

/// Browser DTO is an explicit allowlist, independent of private provider/host
/// locator evolution. Native state and authorization/configuration references
/// are never copied into public responses.
pub(super) fn public_view(value: &Value) -> Value {
    fn fields(value: &Value, keys: &[&str]) -> Value {
        if value.is_null() {
            return Value::Null;
        }
        Value::Object(
            keys.iter()
                .map(|key| ((*key).to_owned(), value[*key].clone()))
                .collect(),
        )
    }
    serde_json::json!({
        "binding": fields(&value["binding"], &[
            "id", "orgId", "conversationId", "targetType", "targetId", "agentId",
            "runtimeType", "continuity", "bindingEpoch", "currentSegmentId", "status",
            "createdAt", "updatedAt",
        ]),
        "segment": fields(&value["segment"], &[
            "id", "bindingId", "runtimeType", "segmentOrdinal", "state", "createdAt", "sealedAt", "updatedAt",
        ]),
    })
}

pub(super) fn binding_matches(
    row: &sqlx::postgres::PgRow,
    identity: &CanonicalIdentity,
) -> Result<bool> {
    Ok(row.try_get::<String, _>("agent_id")? == identity.agent_id
        && row.try_get::<String, _>("runtime_type")? == identity.runtime_type
        && row.try_get::<String, _>("host_id")? == identity.host_id
        && row.try_get::<String, _>("profile_id")? == identity.profile_id
        && row.try_get::<Option<String>, _>("workspace_binding_id")?
            == identity.workspace_binding_id
        && row.try_get::<String, _>("instructions_revision")? == identity.instructions_revision
        && row.try_get::<String, _>("capability_revision")? == identity.capability_revision
        && row.try_get::<String, _>("principal_scope_ref")? == identity.principal_scope_ref)
}

pub(super) async fn binding_json(
    tx: &mut Tx<'_>,
    organization_id: &str,
    binding_id: &str,
) -> Result<Value> {
    let value: Option<String> = sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'id', b.id, 'orgId', b.org_id, 'conversationId', b.conversation_id,
           'targetType', b.target_type, 'targetId', b.target_id,
           'principalScopeRef', b.principal_scope_ref, 'agentId', b.agent_id,
           'runtimeType', b.runtime_type, 'hostId', b.host_id, 'profileId', b.profile_id,
           'workspaceBindingId', b.workspace_binding_id,
           'instructionsRevision', b.instructions_revision,
           'capabilityRevision', b.capability_revision, 'continuity', b.continuity,
           'bindingEpoch', b.binding_epoch, 'currentSegmentId', b.current_segment_id,
           'status', b.status, 'createdAt', b.created_at, 'updatedAt', b.updated_at
         )::text
         FROM runtime_bindings b
         WHERE b.org_id=$1::uuid AND b.id=$2::uuid",
    )
    .bind(organization_id)
    .bind(binding_id)
    .fetch_optional(&mut **tx)
    .await?;
    value
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| http(500, "Invalid runtime binding row"))
        })
        .transpose()?
        .ok_or_else(|| http(404, "Runtime binding not found"))
}

pub(super) async fn segment_json(
    tx: &mut Tx<'_>,
    organization_id: &str,
    binding_id: &str,
    segment_id: &str,
) -> Result<Value> {
    let value: Option<String> = sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'id', s.id, 'orgId', s.org_id, 'bindingId', s.binding_id,
           'runtimeType', s.runtime_type, 'segmentOrdinal', s.segment_ordinal,
           'nativeSessionId', s.native_session_id, 'rootSessionId', s.root_session_id,
           'parentSegmentId', s.parent_segment_id, 'leafId', s.leaf_id,
           'providerState', NULL, 'sourceBoundaryRef', s.source_boundary_ref,
           'state', s.state, 'createdAt', s.created_at, 'sealedAt', s.sealed_at,
           'updatedAt', s.updated_at
         )::text
         FROM native_segments s
         WHERE s.org_id=$1::uuid AND s.binding_id=$2::uuid AND s.id=$3::uuid",
    )
    .bind(organization_id)
    .bind(binding_id)
    .bind(segment_id)
    .fetch_optional(&mut **tx)
    .await?;
    value
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| http(500, "Invalid native segment row"))
        })
        .transpose()?
        .ok_or_else(|| http(404, "Native segment not found"))
}
