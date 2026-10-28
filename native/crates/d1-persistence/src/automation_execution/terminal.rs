//! Automation backlink from an already settled native Chat execution. A held
//! or unresolved native attempt never becomes completed through this path.
use super::*;
use sqlx::Row;

pub(crate) async fn sync_chat_run(tx: &mut Tx<'_>, org: &str, native_run: &str) -> Result<()> {
    let row=sqlx::query("SELECT ar.id::text AS automation_run_id,h.status,h.error,h.finished_at::text AS finished_at,(SELECT m.id::text FROM chat_messages m WHERE m.org_id=h.org_id AND m.conversation_id=g.conversation_id AND m.run_id=h.id AND m.role='assistant' ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS message_id FROM heartbeat_runs h JOIN chat_generations g ON g.org_id=h.org_id AND g.id=h.chat_generation_id JOIN automation_runs ar ON ar.org_id=g.org_id AND ar.linked_chat_conversation_id=g.conversation_id AND ar.started_chat_message_id=g.source_message_id WHERE h.org_id=$1::uuid AND h.id=$2::uuid AND h.execution_authority='native_rust' AND h.status IN ('succeeded','failed','cancelled','timed_out') AND NOT h.native_admission_hold AND NOT g.native_admission_hold AND g.runtime_terminal_at IS NOT NULL AND ar.status='running' AND h.context_snapshot->>'automationRunId'=ar.id::text FOR UPDATE OF ar")
        .bind(org).bind(native_run).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(()) };
    let run: String = row.try_get("automation_run_id")?;
    let native_status: String = row.try_get("status")?;
    let error: Option<String> = row.try_get("error")?;
    let message: Option<String> = row.try_get("message_id")?;
    let finished: Option<String> = row.try_get("finished_at")?;
    sqlx::query("UPDATE automation_runs SET status=$3,failure_reason=$4,terminal_chat_message_id=$5::uuid,last_chat_message_id=COALESCE($5::uuid,last_chat_message_id),completed_at=COALESCE($6::timestamptz,statement_timestamp()),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='running'")
        .bind(org).bind(run).bind(if native_status=="succeeded"{"completed"}else{"failed"}).bind(error).bind(message).bind(finished).execute(&mut **tx).await?;
    Ok(())
}
/// Repair only a missing Automation backlink after a real native terminal
/// commit. This does not terminate, reclaim or relaunch an execution owner.
pub async fn reconcile_chat_runs(pool: &PgPool) -> Result<u64> {
    let runs=sqlx::query_as::<_,(String,String)>("SELECT h.org_id::text,h.id::text FROM automation_runs ar JOIN chat_generations g ON g.org_id=ar.org_id AND g.conversation_id=ar.linked_chat_conversation_id AND g.source_message_id=ar.started_chat_message_id JOIN heartbeat_runs h ON h.org_id=g.org_id AND h.chat_generation_id=g.id WHERE ar.status='running' AND h.context_snapshot->>'automationRunId'=ar.id::text AND h.execution_authority='native_rust' AND h.status IN ('succeeded','failed','cancelled','timed_out') AND NOT h.native_admission_hold AND NOT g.native_admission_hold AND g.runtime_terminal_at IS NOT NULL ORDER BY ar.updated_at LIMIT 200")
        .fetch_all(pool).await?;
    let count = runs.len() as u64;
    for (org, run) in runs {
        let mut tx = pool.begin().await?;
        sync_chat_run(&mut tx, &org, &run).await?;
        tx.commit().await?;
    }
    Ok(count)
}
