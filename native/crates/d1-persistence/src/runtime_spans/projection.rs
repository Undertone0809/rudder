use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};

use super::validation::{Result, http};

pub(super) async fn span_and_segment(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    span_id: &str,
    binding_id: &str,
    segment_id: &str,
) -> Result<Value> {
    let span = span_json(tx, organization_id, span_id).await?;
    let segment = segment_json(tx, organization_id, binding_id, segment_id).await?;
    Ok(json!({"span": span, "segment": segment}))
}

async fn span_json(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    span_id: &str,
) -> Result<Value> {
    let value: Option<String> = sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'id', s.id, 'orgId', s.org_id, 'runId', s.run_id,
           'bindingId', s.binding_id, 'segmentId', s.segment_id,
           'attemptId', s.attempt_id, 'attemptRef', s.attempt_ref,
           'attemptEpoch', s.attempt_epoch, 'ordinal', s.ordinal,
           'relation', s.relation, 'nativeExecutionRef', s.native_execution_ref,
           'inputCorrelationRef', s.input_correlation_ref,
           'sourceRevision', s.source_revision, 'state', s.state,
           'completeness', s.completeness, 'visibilityCutoffRef', s.visibility_cutoff_ref,
           'supplementalObjectRef', s.supplemental_object_ref,
           'openedAt', s.opened_at, 'closedAt', s.closed_at, 'updatedAt', s.updated_at
         )::text
         FROM run_runtime_spans s
         WHERE s.org_id=$1::uuid AND s.id=$2::uuid",
    )
    .bind(organization_id)
    .bind(span_id)
    .fetch_optional(&mut **tx)
    .await?;
    parse(value, "Run span not found")
}

async fn segment_json(
    tx: &mut Transaction<'_, Postgres>,
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
    parse(value, "Native segment not found")
}

fn parse(value: Option<String>, missing: &str) -> Result<Value> {
    value
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| http(500, "Invalid runtime span row"))
        })
        .transpose()?
        .ok_or_else(|| http(404, missing))
}
