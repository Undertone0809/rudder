//! A submitted turn whose local output budget was exhausted may still have an
//! operator Stop. These helpers run inside the finalizer's target transaction.
use super::*;

pub(in crate::native_chat::execution) async fn observe_output_failure_stop(
    tx: &mut auth::Tx<'_>,
    fence: &ExecutionFence,
) -> Result<Option<StopIntent>> {
    let id = fence.identity();
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT a.id::text FROM chat_control_actions a
         JOIN chat_generations g ON g.org_id=a.org_id AND g.id=a.expected_generation_id
         WHERE a.org_id=$1::uuid AND a.expected_generation_id=$2::uuid
           AND g.conversation_id=$3::uuid AND g.execution_authority='native_rust'
           AND g.status IN ('stop_requested','stopping','stopped')
           AND a.action_kind='stop' AND a.last_error IS NULL
           AND a.local_disposition IN ('stop_requested','stopping','stopped')
         ORDER BY a.id LIMIT 2",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.conversation_id)
    .fetch_all(&mut **tx)
    .await?;
    match actions.as_slice() {
        [] => Ok(None),
        [action] => Ok(Some(StopIntent {
            action_id: action.clone(),
            fence: fence.clone(),
        })),
        _ => Err(http(409, "Native Chat Stop action is ambiguous")),
    }
}

pub(in crate::native_chat::execution) async fn resolve_output_failure_stop(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    cleanup: &CleanupReceipt,
    result: &Value,
) -> Result<()> {
    let mut evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    let connection = pin::digest(
        "stop_connection_v1",
        &json!(cleanup.connection_receipt_id()),
    );
    for key in ["interruptConnectionProof", "stoppingConnectionProof"] {
        if evidence
            .get(key)
            .is_some_and(|value| value.as_str() != Some(connection.as_str()))
        {
            return Err(http(409, "Stop cleanup connection changed"));
        }
    }
    if evidence
        .get("stoppingConnectionEpoch")
        .is_some_and(|value| value.as_i64() != Some(i64::from(fence.identity().connection_epoch)))
        || evidence["stoppingObservations"]
            .as_array()
            .is_some_and(|chain| {
                chain
                    .iter()
                    .any(|value| value["connectionProof"].as_str() != Some(connection.as_str()))
            })
    {
        return Err(http(409, "Stop late response connection changed"));
    }
    evidence["stopResolution"] = json!({
        "result":result,"inputDisposition":"unknown","connectionProof":connection,
        "cleanupProven":true,"reason":"visible_output_limit",
    });
    sqlx::query("UPDATE chat_control_actions SET local_disposition='stopped',resolved_at=clock_timestamp(),updated_at=clock_timestamp(),provider_evidence=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&fence.organization_id).bind(&stop.action_id).bind(evidence).execute(&mut **tx).await?;
    auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(())
}
