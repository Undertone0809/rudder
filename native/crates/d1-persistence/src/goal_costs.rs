//! Replayable cost and terminal-state effects for native Goal Runs.
//!
//! The Goal process host finalizes the Run only after a matching cleanup
//! proof. That durable terminal row remains pending until this module writes
//! its idempotent cost event, updates usage/rollups, evaluates budgets, and
//! reconciles Agent status. A failed ledger or budget write leaves the Run
//! pending for this same Rust worker to retry.

use crate::{
    StoreError,
    agent_execution::costs::{RunCostReceipt, settle_ledger},
    goal_budget::{self, GoalBudgetError, GoalCostEventRef},
};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use thiserror::Error;
use uuid::Uuid;

const TERMINAL_EFFECTS_CLAIM_LEASE_SECONDS: i64 = 300;

#[derive(Debug, Error)]
pub enum GoalCostError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    RuntimeBindings(#[from] crate::runtime_bindings::Error),
    #[error(transparent)]
    Budget(#[from] GoalBudgetError),
    #[error("native Goal owner mutation lock is unavailable")]
    OrganizationLock,
    #[error("Goal Run terminal cost receipt is malformed")]
    InvalidReceipt,
    #[error("Goal Run cost event conflicts with its existing finalizer receipt")]
    IdempotencyConflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DueGoalRunTerminalEffects {
    pub organization_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug)]
struct TerminalEffectsClaim {
    organization_id: String,
    agent_id: String,
    run_id: String,
    claim_token: String,
}

async fn mark_native_goal_write(tx: &mut Transaction<'_, Postgres>) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:goal_run_cost',true)")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// List terminal Goal Runs whose process cleanup is proven and whose cost or
/// budget effects have not yet completed.
pub async fn list_due_terminal_effects(
    pool: &PgPool,
) -> Result<Vec<DueGoalRunTerminalEffects>, GoalCostError> {
    let rows = sqlx::query(
        "SELECT org_id::text AS org_id,id::text AS run_id FROM heartbeat_runs
         WHERE execution_authority='native_rust' AND goal_id IS NOT NULL
           AND terminal_effects_json->>'goalRunCostSettlement'='true'
           AND scene='heartbeat' AND target_type='wakeup_request'
           AND terminal_effects_pending=true AND process_exited_at IS NOT NULL
           AND (terminal_effects_next_attempt_at IS NULL
             OR terminal_effects_next_attempt_at <= statement_timestamp())
           AND (terminal_effects_claim_token IS NULL OR terminal_effects_claimed_at IS NULL
             OR terminal_effects_claimed_at < statement_timestamp()-($1::bigint * interval '1 second'))
         ORDER BY finished_at,id LIMIT 32",
    )
    .bind(TERMINAL_EFFECTS_CLAIM_LEASE_SECONDS)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(DueGoalRunTerminalEffects {
                organization_id: row.try_get("org_id")?,
                run_id: row.try_get("run_id")?,
            })
        })
        .collect()
}

/// Any unsettled Goal Run blocks new provider launches until its durable cost
/// and policy effects finish. This is intentionally scoped to native Goal
/// Runs; it does not change legacy process ownership.
pub async fn pending_terminal_effect_organizations(
    pool: &PgPool,
) -> Result<Vec<String>, GoalCostError> {
    sqlx::query_scalar(
        "SELECT DISTINCT org_id::text FROM heartbeat_runs
         WHERE execution_authority='native_rust' AND goal_id IS NOT NULL
           AND terminal_effects_json->>'goalRunCostSettlement'='true'
           AND scene='heartbeat' AND target_type='wakeup_request'
           AND terminal_effects_pending=true ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(GoalCostError::from)
}

/// Claim and replay one run's cost/budget effects. Ledger insertion and
/// runtime totals commit first under a stable finalizer key. Budget evaluation
/// then commits with `budget_evaluated_at` and clearing the run's pending bit.
pub async fn settle_terminal_effects(
    pool: &PgPool,
    organization_id: &str,
    run_id: &str,
) -> Result<bool, GoalCostError> {
    let claim = match claim_terminal_effects(pool, organization_id, run_id).await? {
        Some(claim) => claim,
        None => return Ok(false),
    };

    let result = async {
        let run = write_cost_ledger(pool, &claim).await?;
        evaluate_and_complete(pool, &claim, &run).await
    }
    .await;

    match result {
        Ok(completed) => Ok(completed),
        Err(error) => {
            if let Err(release_error) = release_claim(pool, &claim, &error.to_string()).await {
                tracing::error!(
                    event = "native_goal_terminal_effect_claim_release_failed",
                    run_id = %claim.run_id,
                    error = %release_error,
                );
            }
            Err(error)
        }
    }
}

async fn claim_terminal_effects(
    pool: &PgPool,
    organization_id: &str,
    run_id: &str,
) -> Result<Option<TerminalEffectsClaim>, GoalCostError> {
    let organization_id = Uuid::parse_str(organization_id)
        .map_err(|_| GoalCostError::InvalidReceipt)?
        .to_string();
    let run_id = Uuid::parse_str(run_id)
        .map_err(|_| GoalCostError::InvalidReceipt)?
        .to_string();
    let known_org: Option<String> = sqlx::query_scalar(
        "SELECT org_id::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid
           AND execution_authority='native_rust' AND goal_id IS NOT NULL
           AND terminal_effects_json->>'goalRunCostSettlement'='true'
           AND scene='heartbeat' AND target_type='wakeup_request'",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .fetch_optional(pool)
    .await?;
    let Some(known_org) = known_org else {
        return Ok(None);
    };

    let mut tx = pool.begin().await?;
    crate::native_chat::lock_goal_run_budget_state(&mut tx, &known_org).await?;
    crate::goal_writes::lock_goal_run_organization(&mut tx, &known_org)
        .await
        .map_err(map_organization_lock)?;
    mark_native_goal_write(&mut tx).await?;
    let claim_token = Uuid::new_v4().to_string();
    let row = sqlx::query(
        "UPDATE heartbeat_runs SET terminal_effects_claim_token=$3,
             terminal_effects_claimed_at=statement_timestamp(),
             terminal_effects_attempt_count=terminal_effects_attempt_count+1,
             terminal_effects_next_attempt_at=NULL,terminal_effects_last_error=NULL,
             updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND goal_id IS NOT NULL AND terminal_effects_json->>'goalRunCostSettlement'='true' AND scene='heartbeat' AND target_type='wakeup_request'
           AND terminal_effects_pending=true AND process_exited_at IS NOT NULL
           AND (terminal_effects_next_attempt_at IS NULL
             OR terminal_effects_next_attempt_at <= statement_timestamp())
           AND (terminal_effects_claim_token IS NULL OR terminal_effects_claimed_at IS NULL
             OR terminal_effects_claimed_at < statement_timestamp()-($4::bigint * interval '1 second'))
         RETURNING org_id::text AS org_id,agent_id::text AS agent_id,id::text AS run_id",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(&claim_token)
    .bind(TERMINAL_EFFECTS_CLAIM_LEASE_SECONDS)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(None);
    };
    let claim = TerminalEffectsClaim {
        organization_id: row.try_get("org_id")?,
        agent_id: row.try_get("agent_id")?,
        run_id: row.try_get("run_id")?,
        claim_token,
    };
    tx.commit().await?;
    Ok(Some(claim))
}

fn map_organization_lock(error: StoreError) -> GoalCostError {
    match error {
        StoreError::Database(error) => GoalCostError::Database(error),
        _ => GoalCostError::OrganizationLock,
    }
}

async fn write_cost_ledger(
    pool: &PgPool,
    claim: &TerminalEffectsClaim,
) -> Result<RunCostReceipt, GoalCostError> {
    let mut tx = pool.begin().await?;
    crate::native_chat::lock_goal_run_budget_state(&mut tx, &claim.organization_id).await?;
    crate::goal_writes::lock_goal_run_organization(&mut tx, &claim.organization_id)
        .await
        .map_err(map_organization_lock)?;
    mark_native_goal_write(&mut tx).await?;

    let run_row = sqlx::query(
        "SELECT org_id::text AS org_id,agent_id::text AS agent_id,goal_id::text AS goal_id,
                id::text AS run_id,status,error,usage_json::text AS usage_json,
                result_json::text AS result_json,context_snapshot::text AS context_snapshot,
                created_at::text AS created_at
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid
           AND execution_authority='native_rust' AND goal_id IS NOT NULL
           AND terminal_effects_json->>'goalRunCostSettlement'='true'
           AND terminal_effects_pending=true AND terminal_effects_claim_token=$3
           AND process_exited_at IS NOT NULL
         FOR UPDATE",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.claim_token)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(GoalCostError::InvalidReceipt)?;
    let receipt = RunCostReceipt {
        organization_id: run_row.try_get("org_id")?,
        agent_id: run_row.try_get("agent_id")?,
        goal_id: Some(run_row.try_get("goal_id")?),
        issue_id: None,
        project_id: None,
        billing_code: None,
        session_id: parse_json(run_row.try_get("result_json")?)
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        run_id: run_row.try_get("run_id")?,
        status: run_row.try_get("status")?,
        error: run_row.try_get("error")?,
        usage: parse_json(run_row.try_get("usage_json")?),
        result: parse_json(run_row.try_get("result_json")?),
    };
    settle_ledger(&mut tx, &receipt).await?;
    tx.commit().await?;
    Ok(receipt)
}

fn parse_json(value: Option<String>) -> Value {
    value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(Value::Null)
}

async fn evaluate_and_complete(
    pool: &PgPool,
    claim: &TerminalEffectsClaim,
    run: &RunCostReceipt,
) -> Result<bool, GoalCostError> {
    let mut tx = pool.begin().await?;
    crate::native_chat::lock_goal_run_budget_state(&mut tx, &claim.organization_id).await?;
    crate::goal_writes::lock_goal_run_organization(&mut tx, &claim.organization_id)
        .await
        .map_err(map_organization_lock)?;
    mark_native_goal_write(&mut tx).await?;

    let event = sqlx::query(
        "SELECT id::text AS id,budget_evaluated_at::text AS budget_evaluated_at
         FROM cost_events WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(&claim.organization_id)
    .bind(format!("heartbeat-run-finalizer:{}", claim.run_id))
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(event) = event {
        let event_id: String = event.try_get("id")?;
        let evaluated: Option<String> = event.try_get("budget_evaluated_at")?;
        if evaluated.is_none() {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(format!("heartbeat-run-budget:{event_id}"))
                .execute(&mut *tx)
                .await?;
            let still_unevaluated: bool = sqlx::query_scalar(
                "SELECT budget_evaluated_at IS NULL FROM cost_events WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(&claim.organization_id)
            .bind(&event_id)
            .fetch_one(&mut *tx)
            .await?;
            if still_unevaluated {
                goal_budget::evaluate_cost_event(
                    &mut tx,
                    &GoalCostEventRef {
                        id: &event_id,
                        org_id: &run.organization_id,
                        agent_id: &run.agent_id,
                    },
                )
                .await?;
            }
        }
    }

    let completed = sqlx::query(
        "UPDATE heartbeat_runs SET terminal_effects_pending=false,terminal_effects_json=NULL,
           terminal_effects_completed_json=NULL,terminal_effects_dead_lettered_json=NULL,
           terminal_effects_attempts_json=NULL,terminal_effects_next_attempt_at=NULL,
           terminal_effects_dead_lettered_at=NULL,terminal_effects_claim_token=NULL,
           terminal_effects_claimed_at=NULL,terminal_effects_last_error=NULL,
           updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND terminal_effects_pending=true AND terminal_effects_claim_token=$3
           AND process_exited_at IS NOT NULL RETURNING agent_id::text AS agent_id",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.claim_token)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(_completed) = completed else {
        tx.rollback().await?;
        return Ok(false);
    };

    reconcile_agent_status(&mut tx, &claim.organization_id, &claim.agent_id).await?;
    tx.commit().await?;
    Ok(true)
}

async fn reconcile_agent_status(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    agent_id: &str,
) -> Result<(), GoalCostError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{agent_id}"))
        .execute(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(org_id)
        .bind(agent_id)
        .fetch_optional(&mut **tx)
        .await?;
    let active_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid
           AND (status='running' OR terminal_effects_pending=true)",
    )
    .bind(org_id)
    .bind(agent_id)
    .fetch_one(&mut **tx)
    .await?;
    let latest_terminal: Option<String> = sqlx::query_scalar(
        "SELECT status FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid
           AND status IN ('succeeded','failed','cancelled','timed_out')
         ORDER BY finished_at DESC,created_at DESC,id DESC LIMIT 1",
    )
    .bind(org_id)
    .bind(agent_id)
    .fetch_optional(&mut **tx)
    .await?;
    let next_status = if active_count > 0 {
        "running"
    } else if matches!(latest_terminal.as_deref(), Some("succeeded" | "cancelled")) {
        "idle"
    } else {
        "error"
    };
    sqlx::query(
        "UPDATE agents SET status=$3,last_heartbeat_at=statement_timestamp(),
           updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid
           AND status NOT IN ('paused','terminated','pending_approval')",
    )
    .bind(org_id)
    .bind(agent_id)
    .bind(next_status)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn release_claim(
    pool: &PgPool,
    claim: &TerminalEffectsClaim,
    error: &str,
) -> Result<(), GoalCostError> {
    let safe_error = error.chars().take(500).collect::<String>();
    let mut tx = pool.begin().await?;
    mark_native_goal_write(&mut tx).await?;
    sqlx::query(
        "UPDATE heartbeat_runs SET terminal_effects_claim_token=NULL,
           terminal_effects_claimed_at=NULL,terminal_effects_next_attempt_at=
             statement_timestamp()+$4::int*interval '1 second',
           terminal_effects_last_error=$5,updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND terminal_effects_pending=true AND terminal_effects_claim_token=$3",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.claim_token)
    .bind(1_i32)
    .bind(safe_error)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
