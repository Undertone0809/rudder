//! Replayable terminal effects for generic native heartbeat Runs. Existing Goal
//! cost intents remain under their original owner; neither queue consumes both.
mod automation;
mod issue_release;
mod issue_requests;
mod session;

use super::{
    AgentExecutionError,
    costs::{RunCostReceipt, settle_ledger},
    http, mark_native_write,
};
use crate::goal_budget::{self, GoalCostEventRef};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

const EFFECTS: &[&str] = &[
    "runtime_cost",
    "automation_chat",
    "task_session",
    "agent_issue_creation_settlement",
    "agent_issue_creation_notification",
    "process_loss_retry",
    "issue_release",
];

#[derive(Clone)]
pub struct DueAgentRunTerminalEffects {
    pub organization_id: String,
    pub run_id: String,
}

pub(super) struct TerminalRun {
    pub org: String,
    pub id: String,
    pub agent_id: String,
    pub runtime_type: String,
    pub status: String,
    pub error: Option<String>,
    pub error_code: Option<String>,
    pub goal_id: Option<String>,
    pub context: Value,
    pub usage: Value,
    pub result: Value,
    pub session_id_after: Option<String>,
    pub session_params_after: Option<Value>,
}
struct Claim {
    org: String,
    id: String,
    agent_id: String,
    token: String,
    completed: Vec<String>,
}

pub async fn list_due(
    pool: &PgPool,
) -> Result<Vec<DueAgentRunTerminalEffects>, AgentExecutionError> {
    let rows=sqlx::query("SELECT org_id::text AS org,id::text AS id FROM heartbeat_runs WHERE execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request' AND terminal_effects_json->>'nativeAgentRunSettlement'='true' AND terminal_effects_pending=true AND (process_exited_at IS NOT NULL OR (terminal_effects_json->>'nativeRequestOwnerLost'='true' AND status='failed' AND error_code='runtime_owner_lost')) AND (terminal_effects_next_attempt_at IS NULL OR terminal_effects_next_attempt_at<=statement_timestamp()) AND (terminal_effects_claim_token IS NULL OR terminal_effects_claimed_at IS NULL OR terminal_effects_claimed_at<statement_timestamp()-interval '300 seconds') ORDER BY updated_at,id LIMIT 32")
        .fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok(DueAgentRunTerminalEffects {
                organization_id: row.try_get("org")?,
                run_id: row.try_get("id")?,
            })
        })
        .collect()
}

pub async fn settle_terminal_effects(
    pool: &PgPool,
    org: &str,
    run_id: &str,
) -> Result<bool, AgentExecutionError> {
    let Some(mut claim) = claim(pool, org, run_id).await? else {
        return Ok(false);
    };
    for effect in EFFECTS {
        if claim.completed.iter().any(|done| done == effect) {
            continue;
        }
        let outcome = run_effect(pool, &claim, effect).await;
        if let Err(error) = outcome {
            release(pool, &claim, effect).await?;
            return Err(error);
        }
        let mut tx = pool.begin().await?;
        mark_native_write(&mut tx).await?;
        let changed=sqlx::query("UPDATE heartbeat_runs SET terminal_effects_completed_json=COALESCE(terminal_effects_completed_json,'[]'::jsonb)||jsonb_build_array($4::text),terminal_effects_claimed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND terminal_effects_pending=true AND terminal_effects_claim_token=$3 AND NOT (COALESCE(terminal_effects_completed_json,'[]'::jsonb)?$4)")
            .bind(&claim.org).bind(&claim.id).bind(&claim.token).bind(effect).execute(&mut *tx).await?.rows_affected()==1;
        tx.commit().await?;
        if !changed {
            return Err(http(409, "Native Agent terminal effects claim was lost"));
        }
        claim.completed.push((*effect).into());
    }
    complete(pool, &claim).await
}

async fn claim(
    pool: &PgPool,
    org: &str,
    run_id: &str,
) -> Result<Option<Claim>, AgentExecutionError> {
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
    let token = Uuid::new_v4().to_string();
    let row=sqlx::query("UPDATE heartbeat_runs SET terminal_effects_claim_token=$3,terminal_effects_claimed_at=statement_timestamp(),terminal_effects_attempt_count=terminal_effects_attempt_count+1,terminal_effects_next_attempt_at=NULL,terminal_effects_last_error=NULL WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request' AND status IN ('succeeded','failed','cancelled','timed_out') AND terminal_effects_json->>'nativeAgentRunSettlement'='true' AND terminal_effects_pending=true AND (process_exited_at IS NOT NULL OR (terminal_effects_json->>'nativeRequestOwnerLost'='true' AND status='failed' AND error_code='runtime_owner_lost')) AND (terminal_effects_next_attempt_at IS NULL OR terminal_effects_next_attempt_at<=statement_timestamp()) AND (terminal_effects_claim_token IS NULL OR terminal_effects_claimed_at IS NULL OR terminal_effects_claimed_at<statement_timestamp()-interval '300 seconds') RETURNING agent_id::text AS agent_id,terminal_effects_completed_json")
        .bind(org).bind(run_id).bind(&token).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let completed = row
        .try_get::<Option<Value>, _>("terminal_effects_completed_json")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect();
    let claim = Claim {
        org: org.into(),
        id: run_id.into(),
        agent_id: row.try_get("agent_id")?,
        token,
        completed,
    };
    tx.commit().await?;
    Ok(Some(claim))
}

async fn run_effect(pool: &PgPool, claim: &Claim, effect: &str) -> Result<(), AgentExecutionError> {
    if effect == "runtime_cost" {
        return settle_cost(pool, claim).await;
    }
    let mut tx = pool.begin().await?;
    let run = load(&mut tx, claim).await?;
    mark_native_write(&mut tx).await?;
    match effect {
        "automation_chat" => automation::settle(&mut tx, &run).await?,
        "task_session" => session::settle(&mut tx, &run).await?,
        "agent_issue_creation_settlement" => issue_requests::settle(&mut tx, &run).await?,
        // The existing notification shares the Issue-creation transaction and
        // idempotency key; its replay is safe when settlement already completed.
        "agent_issue_creation_notification" => issue_requests::settle(&mut tx, &run).await?,
        "process_loss_retry" => issue_release::process_loss_retry(&mut tx, &run).await?,
        "issue_release" => issue_release::settle(&mut tx, &run).await?,
        _ => return Err(http(500, "Unknown native Agent terminal effect")),
    }
    ensure_claim(&mut tx, claim).await?;
    tx.commit().await?;
    Ok(())
}

async fn settle_cost(pool: &PgPool, claim: &Claim) -> Result<(), AgentExecutionError> {
    let mut tx = pool.begin().await?;
    crate::native_chat::lock_goal_run_budget_state(&mut tx, &claim.org)
        .await
        .map_err(crate::goal_runs::GoalRunError::from)?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(&claim.org)
        .execute(&mut *tx)
        .await?;
    let run = load(&mut tx, claim).await?;
    mark_native_write(&mut tx).await?;
    let issue_id = super::context::nonempty(run.context.get("issueId"));
    let project_id = super::context::nonempty(run.context.get("projectId"));
    let billing_code = super::context::nonempty(run.context.get("billingCode"));
    let mut ledger_usage = run.usage.clone();
    if let Some(fields) = ledger_usage.as_object_mut() {
        for key in ["rawInputTokens", "rawCachedInputTokens", "rawOutputTokens"] {
            fields.remove(key);
        }
    }
    settle_ledger(
        &mut tx,
        &RunCostReceipt {
            organization_id: run.org.clone(),
            agent_id: run.agent_id.clone(),
            goal_id: run.goal_id.clone(),
            issue_id,
            project_id,
            billing_code,
            session_id: run.session_id_after.clone(),
            run_id: run.id.clone(),
            status: run.status.clone(),
            error: run.error.clone(),
            usage: run.usage.clone(),
            ledger_usage: Some(ledger_usage),
            result: run.result.clone(),
        },
    )
    .await?;
    let event=sqlx::query("SELECT id::text AS id,budget_evaluated_at IS NOT NULL AS evaluated FROM cost_events WHERE org_id=$1::uuid AND idempotency_key=$2 FOR UPDATE")
        .bind(&claim.org).bind(format!("heartbeat-run-finalizer:{}",claim.id)).fetch_optional(&mut *tx).await?;
    if let Some(event) = event
        && !event.try_get::<bool, _>("evaluated")?
    {
        goal_budget::evaluate_cost_event(
            &mut tx,
            &GoalCostEventRef {
                id: &event.try_get::<String, _>("id")?,
                org_id: &run.org,
                agent_id: &run.agent_id,
            },
        )
        .await?;
    }
    ensure_claim(&mut tx, claim).await?;
    tx.commit().await?;
    Ok(())
}

async fn load(
    tx: &mut Transaction<'_, Postgres>,
    claim: &Claim,
) -> Result<TerminalRun, AgentExecutionError> {
    let row=sqlx::query("SELECT r.org_id::text AS org,r.id::text AS id,r.agent_id::text AS agent_id,COALESCE(attempt.runtime_type,a.agent_runtime_type) AS runtime_type,r.status,r.error,r.error_code,r.goal_id::text AS goal_id,r.context_snapshot,r.usage_json,r.result_json,COALESCE(r.session_id_after,attempt.session_display_id) AS session_id_after,COALESCE(r.session_params_after_json,attempt.session_params_json) AS session_params_after FROM heartbeat_runs r JOIN agents a ON a.org_id=r.org_id AND a.id=r.agent_id LEFT JOIN LATERAL(SELECT runtime_type,session_display_id,session_params_json FROM heartbeat_run_attempts WHERE org_id=r.org_id AND run_id=r.id ORDER BY attempt_index DESC LIMIT 1)attempt ON true WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust' AND r.terminal_effects_pending=true AND r.terminal_effects_claim_token=$3 AND (r.process_exited_at IS NOT NULL OR (r.terminal_effects_json->>'nativeRequestOwnerLost'='true' AND r.status='failed' AND r.error_code='runtime_owner_lost'))")
        .bind(&claim.org).bind(&claim.id).bind(&claim.token).fetch_optional(&mut **tx).await?.ok_or_else(||http(409,"Native Agent terminal effects claim was lost"))?;
    Ok(TerminalRun {
        org: row.try_get("org")?,
        id: row.try_get("id")?,
        agent_id: row.try_get("agent_id")?,
        runtime_type: row.try_get("runtime_type")?,
        status: row.try_get("status")?,
        error: row.try_get("error")?,
        error_code: row.try_get("error_code")?,
        goal_id: row.try_get("goal_id")?,
        context: row
            .try_get::<Option<Value>, _>("context_snapshot")?
            .unwrap_or_else(|| json!({})),
        usage: row
            .try_get::<Option<Value>, _>("usage_json")?
            .unwrap_or(Value::Null),
        result: row
            .try_get::<Option<Value>, _>("result_json")?
            .unwrap_or(Value::Null),
        session_id_after: row.try_get("session_id_after")?,
        session_params_after: row.try_get("session_params_after")?,
    })
}

async fn ensure_claim(
    tx: &mut Transaction<'_, Postgres>,
    claim: &Claim,
) -> Result<(), AgentExecutionError> {
    let changed=sqlx::query("UPDATE heartbeat_runs SET terminal_effects_claimed_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND terminal_effects_claim_token=$3 AND terminal_effects_pending=true")
        .bind(&claim.org).bind(&claim.id).bind(&claim.token).execute(&mut **tx).await?.rows_affected()==1;
    if !changed {
        return Err(http(409, "Native Agent terminal effects claim was lost"));
    }
    Ok(())
}
async fn release(pool: &PgPool, claim: &Claim, effect: &str) -> Result<(), AgentExecutionError> {
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET terminal_effects_claim_token=NULL,terminal_effects_claimed_at=NULL,terminal_effects_last_error=$4,terminal_effects_next_attempt_at=statement_timestamp()+make_interval(secs=>LEAST(300,5*power(2,LEAST(terminal_effects_attempt_count,6)))::int),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND terminal_effects_claim_token=$3 AND terminal_effects_pending=true")
        .bind(&claim.org).bind(&claim.id).bind(&claim.token).bind(format!("Native Agent terminal effect pending: {effect}")).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
async fn complete(pool: &PgPool, claim: &Claim) -> Result<bool, AgentExecutionError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{}", claim.agent_id))
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&claim.org)
        .bind(&claim.agent_id)
        .execute(&mut *tx)
        .await?;
    mark_native_write(&mut tx).await?;
    let changed=sqlx::query("UPDATE heartbeat_runs SET terminal_effects_pending=false,terminal_effects_json=NULL,terminal_effects_claim_token=NULL,terminal_effects_claimed_at=NULL,terminal_effects_next_attempt_at=NULL,terminal_effects_last_error=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND terminal_effects_claim_token=$3 AND terminal_effects_pending=true AND COALESCE(terminal_effects_completed_json,'[]'::jsonb)@>$4::jsonb")
        .bind(&claim.org).bind(&claim.id).bind(&claim.token).bind(json!(EFFECTS)).execute(&mut *tx).await?.rows_affected()==1;
    if changed {
        crate::goal_costs::reconcile_agent_status(&mut tx, &claim.org, &claim.agent_id).await?;
    }
    tx.commit().await?;
    Ok(changed)
}
