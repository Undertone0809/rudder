//! Monotonic task-session terminal effects, preserving a newer Run's session.
use super::TerminalRun;
use crate::agent_execution::{AgentExecutionError, context, mark_native_write};
use serde_json::Value;
use sqlx::{Postgres, Transaction};

pub(super) async fn settle(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
) -> Result<(), AgentExecutionError> {
    let Some(task) = context::task_key(&run.context, &Value::Null) else {
        return Ok(());
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!(
            "task-session:{}:{}:{}:{task}",
            run.org, run.agent_id, run.runtime_type
        ))
        .execute(&mut **tx)
        .await?;
    mark_native_write(tx).await?;
    let cleared = run.session_id_after.is_none()
        && run
            .session_params_after
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|fields| fields.is_empty());
    if cleared {
        sqlx::query("DELETE FROM agent_task_sessions current WHERE org_id=$1::uuid AND agent_id=$2::uuid AND agent_runtime_type=$3 AND task_key=$4 AND (last_run_id IS NULL OR last_run_id=$5::uuid OR NOT EXISTS(SELECT 1 FROM heartbeat_runs previous JOIN heartbeat_runs source ON source.id=$5::uuid WHERE previous.id=current.last_run_id AND (previous.created_at>source.created_at OR (previous.created_at=source.created_at AND previous.id>source.id))))")
            .bind(&run.org).bind(&run.agent_id).bind(&run.runtime_type).bind(task).bind(&run.id).execute(&mut **tx).await?;
        return Ok(());
    }
    if run.session_params_after.is_none() && run.session_id_after.is_none() {
        return Ok(());
    }
    sqlx::query("INSERT INTO agent_task_sessions AS current(org_id,agent_id,agent_runtime_type,task_key,session_params_json,session_display_id,last_run_id,last_error) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6,$7::uuid,$8) ON CONFLICT(org_id,agent_id,agent_runtime_type,task_key) DO UPDATE SET session_params_json=EXCLUDED.session_params_json,session_display_id=EXCLUDED.session_display_id,last_run_id=EXCLUDED.last_run_id,last_error=EXCLUDED.last_error,updated_at=statement_timestamp() WHERE current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id OR NOT EXISTS(SELECT 1 FROM heartbeat_runs previous JOIN heartbeat_runs incoming ON incoming.id=EXCLUDED.last_run_id WHERE previous.id=current.last_run_id AND (previous.created_at>incoming.created_at OR (previous.created_at=incoming.created_at AND previous.id>incoming.id)))")
        .bind(&run.org).bind(&run.agent_id).bind(&run.runtime_type).bind(task).bind(&run.session_params_after).bind(&run.session_id_after).bind(&run.id).bind(&run.error).execute(&mut **tx).await?;
    Ok(())
}
