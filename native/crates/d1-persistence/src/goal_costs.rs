//! Replayable cost and terminal-state effects for native Goal Runs.
//!
//! The Goal process host finalizes the Run only after a matching cleanup
//! proof. That durable terminal row remains pending until this module writes
//! its idempotent cost event, updates usage/rollups, evaluates budgets, and
//! reconciles Agent status. A failed ledger or budget write leaves the Run
//! pending for this same Rust worker to retry.

use crate::{
    StoreError,
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

#[derive(Clone, Debug)]
struct RunCostReceipt {
    organization_id: String,
    agent_id: String,
    goal_id: String,
    run_id: String,
    status: String,
    error: Option<String>,
    usage: Value,
    result: Value,
}

#[derive(Clone, Debug)]
struct LedgerReceipt {
    inserted: bool,
    provider: String,
    biller: String,
    billing_type: String,
    model: String,
    input_tokens: i32,
    cached_input_tokens: i32,
    output_tokens: i32,
    cost_cents: i32,
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
           AND goal_id IS NOT NULL AND scene='heartbeat' AND target_type='wakeup_request'
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
        goal_id: run_row.try_get("goal_id")?,
        run_id: run_row.try_get("run_id")?,
        status: run_row.try_get("status")?,
        error: run_row.try_get("error")?,
        usage: parse_json(run_row.try_get("usage_json")?),
        result: parse_json(run_row.try_get("result_json")?),
    };
    let ledger = normalize_ledger_receipt(&receipt)?;
    let cost_event = if should_write_cost_event(&ledger) {
        let event_id = insert_cost_event(&mut tx, &receipt, &ledger).await?;
        if event_id.inserted {
            update_monthly_rollups(&mut tx, &receipt, &ledger).await?;
            update_spent_monthly(&mut tx, &receipt).await?;
        }
        Some(event_id)
    } else {
        None
    };

    update_agent_runtime_state(
        &mut tx,
        &receipt,
        &ledger,
        cost_event.as_ref().is_some_and(|e| e.inserted),
    )
    .await?;
    tx.commit().await?;
    Ok(receipt)
}

fn parse_json(value: Option<String>) -> Value {
    value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(Value::Null)
}

fn bounded_nonnegative_i32(value: Option<&Value>) -> Result<i32, GoalCostError> {
    let value = value.and_then(Value::as_i64).unwrap_or_default().max(0);
    i32::try_from(value).map_err(|_| GoalCostError::InvalidReceipt)
}

fn normalize_ledger_receipt(run: &RunCostReceipt) -> Result<LedgerReceipt, GoalCostError> {
    let usage = &run.usage;
    let provider = run
        .result
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown")
        .trim()
        .to_owned();
    let biller = run
        .result
        .get("biller")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&provider)
        .trim()
        .to_owned();
    let raw_billing = usage
        .get("billingType")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let billing_type = match raw_billing.trim() {
        "api" | "metered_api" => "metered_api",
        "subscription" | "subscription_included" => "subscription_included",
        "subscription_overage" => "subscription_overage",
        "credits" => "credits",
        "fixed" => "fixed",
        _ => "unknown",
    }
    .to_owned();
    let cost_usd = usage
        .get("costUsd")
        .and_then(Value::as_f64)
        .or_else(|| {
            run.result
                .get("totalCostUsdMicros")
                .and_then(Value::as_u64)
                .map(|micros| micros as f64 / 1_000_000.0)
        })
        .unwrap_or_default();
    if !cost_usd.is_finite() {
        return Err(GoalCostError::InvalidReceipt);
    }
    let cost_cents = if billing_type == "subscription_included" {
        0
    } else {
        (cost_usd * 100.0).round().max(0.0) as i64
    };
    let cost_cents = i32::try_from(cost_cents).map_err(|_| GoalCostError::InvalidReceipt)?;
    let input_tokens =
        bounded_nonnegative_i32(usage.get("rawInputTokens").or(usage.get("inputTokens")))?;
    let cached_input_tokens = bounded_nonnegative_i32(
        usage
            .get("rawCachedInputTokens")
            .or(usage.get("cachedInputTokens")),
    )?;
    let output_tokens =
        bounded_nonnegative_i32(usage.get("rawOutputTokens").or(usage.get("outputTokens")))?;
    let model = run
        .result
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown")
        .to_owned();
    Ok(LedgerReceipt {
        inserted: false,
        provider,
        biller,
        billing_type,
        model,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        cost_cents,
    })
}

fn should_write_cost_event(ledger: &LedgerReceipt) -> bool {
    ledger.cost_cents > 0
        || ledger.input_tokens > 0
        || ledger.cached_input_tokens > 0
        || ledger.output_tokens > 0
}

async fn insert_cost_event(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
    ledger: &LedgerReceipt,
) -> Result<LedgerReceipt, GoalCostError> {
    let idempotency_key = format!("heartbeat-run-finalizer:{}", run.run_id);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("heartbeat-run-cost:{}", run.run_id))
        .execute(&mut **tx)
        .await?;

    // Match the existing Node finalizer's adoption behavior. Older run costs
    // could have been written without an idempotency key; adopt only an exact
    // Goal-scoped match so a retry does not charge the same result twice.
    let keyed_event_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM cost_events WHERE org_id=$1::uuid AND idempotency_key=$2)",
    )
    .bind(&run.organization_id)
    .bind(&idempotency_key)
    .fetch_one(&mut **tx)
    .await?;
    let legacy_id: Option<String> = if keyed_event_exists {
        None
    } else {
        sqlx::query_scalar(
            "SELECT id::text FROM cost_events
         WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid
           AND idempotency_key IS NULL AND agent_id=$3::uuid
           AND issue_id IS NULL AND project_id IS NULL AND goal_id=$4::uuid
           AND billing_code IS NULL AND provider=$5 AND biller=$6
           AND billing_type=$7 AND model=$8 AND input_tokens=$9
           AND cached_input_tokens=$10 AND output_tokens=$11 AND cost_cents=$12
         ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .bind(&run.organization_id)
        .bind(&run.run_id)
        .bind(&run.agent_id)
        .bind(&run.goal_id)
        .bind(&ledger.provider)
        .bind(&ledger.biller)
        .bind(&ledger.billing_type)
        .bind(&ledger.model)
        .bind(ledger.input_tokens)
        .bind(ledger.cached_input_tokens)
        .bind(ledger.output_tokens)
        .bind(ledger.cost_cents)
        .fetch_optional(&mut **tx)
        .await?
    };
    if let Some(legacy_id) = legacy_id {
        let adopted: Option<bool> = sqlx::query_scalar(
            "UPDATE cost_events SET idempotency_key=$2
             WHERE org_id=$1::uuid AND id=$3::uuid AND idempotency_key IS NULL
             RETURNING true",
        )
        .bind(&run.organization_id)
        .bind(&idempotency_key)
        .bind(legacy_id)
        .fetch_optional(&mut **tx)
        .await?;
        if adopted.is_some() {
            let mut receipt = ledger.clone();
            receipt.inserted = false;
            return Ok(receipt);
        }
    }

    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO cost_events
           (org_id,agent_id,goal_id,heartbeat_run_id,idempotency_key,provider,biller,
            billing_type,model,input_tokens,cached_input_tokens,output_tokens,cost_cents,occurred_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,statement_timestamp())
         ON CONFLICT (org_id,idempotency_key) DO NOTHING RETURNING id::text",
    )
    .bind(&run.organization_id)
    .bind(&run.agent_id)
    .bind(&run.goal_id)
    .bind(&run.run_id)
    .bind(&idempotency_key)
    .bind(&ledger.provider)
    .bind(&ledger.biller)
    .bind(&ledger.billing_type)
    .bind(&ledger.model)
    .bind(ledger.input_tokens)
    .bind(ledger.cached_input_tokens)
    .bind(ledger.output_tokens)
    .bind(ledger.cost_cents)
    .fetch_optional(&mut **tx)
    .await?;
    let newly_inserted = inserted.is_some();
    if !newly_inserted {
        let existing = sqlx::query(
            "SELECT id::text AS id,agent_id::text AS agent_id,goal_id::text AS goal_id,
                    heartbeat_run_id::text AS run_id,provider,biller,billing_type,model,
                    input_tokens,cached_input_tokens,output_tokens,cost_cents
             FROM cost_events WHERE org_id=$1::uuid AND idempotency_key=$2",
        )
        .bind(&run.organization_id)
        .bind(&idempotency_key)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(GoalCostError::IdempotencyConflict)?;
        let matches = existing.try_get::<String, _>("agent_id")? == run.agent_id
            && existing.try_get::<Option<String>, _>("goal_id")?.as_deref() == Some(&run.goal_id)
            && existing.try_get::<Option<String>, _>("run_id")?.as_deref() == Some(&run.run_id)
            && existing.try_get::<String, _>("provider")? == ledger.provider
            && existing.try_get::<String, _>("biller")? == ledger.biller
            && existing.try_get::<String, _>("billing_type")? == ledger.billing_type
            && existing.try_get::<String, _>("model")? == ledger.model
            && existing.try_get::<i32, _>("input_tokens")? == ledger.input_tokens
            && existing.try_get::<i32, _>("cached_input_tokens")? == ledger.cached_input_tokens
            && existing.try_get::<i32, _>("output_tokens")? == ledger.output_tokens
            && existing.try_get::<i32, _>("cost_cents")? == ledger.cost_cents;
        if !matches {
            return Err(GoalCostError::IdempotencyConflict);
        }
    }
    let mut receipt = ledger.clone();
    receipt.inserted = newly_inserted;
    Ok(receipt)
}

async fn update_monthly_rollups(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
    ledger: &LedgerReceipt,
) -> Result<(), GoalCostError> {
    let window = sqlx::query(
        "SELECT to_char(date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC'),
                        'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS month_start,
                to_char(date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') + interval '1 month',
                        'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS month_end",
    )
    .fetch_one(&mut **tx)
    .await?;
    let month_start: String = window.try_get("month_start")?;
    let month_end: String = window.try_get("month_end")?;
    for (scope_type, scope_id) in [
        ("agent", run.agent_id.as_str()),
        ("organization", run.organization_id.as_str()),
    ] {
        let inserted = sqlx::query_scalar::<_, String>(
            "INSERT INTO cost_monthly_spend_rollups
               (org_id,scope_type,scope_id,month_start,spend_cents)
             VALUES($1::uuid,$2,$3,$4::timestamptz,$5)
             ON CONFLICT (org_id,scope_type,scope_id,month_start) DO NOTHING
             RETURNING id::text",
        )
        .bind(&run.organization_id)
        .bind(scope_type)
        .bind(scope_id)
        .bind(&month_start)
        .bind(ledger.cost_cents)
        .fetch_optional(&mut **tx)
        .await?;
        if inserted.is_some() {
            sqlx::query(
                "UPDATE cost_monthly_spend_rollups r
                 SET spend_cents=(SELECT COALESCE(sum(c.cost_cents),0)::int FROM cost_events c
                   WHERE c.org_id=$1::uuid AND c.occurred_at >= $4::timestamptz
                     AND c.occurred_at < $5::timestamptz
                     AND ($2 <> 'agent' OR c.agent_id=$3::uuid)),updated_at=statement_timestamp()
                 WHERE r.org_id=$1::uuid AND r.scope_type=$2 AND r.scope_id=$3
                   AND r.month_start=$4::timestamptz",
            )
            .bind(&run.organization_id)
            .bind(scope_type)
            .bind(scope_id)
            .bind(&month_start)
            .bind(&month_end)
            .execute(&mut **tx)
            .await?;
        } else {
            sqlx::query(
                "UPDATE cost_monthly_spend_rollups SET spend_cents=spend_cents+$5,
                   updated_at=statement_timestamp()
                 WHERE org_id=$1::uuid AND scope_type=$2 AND scope_id=$3
                   AND month_start=$4::timestamptz",
            )
            .bind(&run.organization_id)
            .bind(scope_type)
            .bind(scope_id)
            .bind(&month_start)
            .bind(ledger.cost_cents)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}

async fn update_spent_monthly(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
) -> Result<(), GoalCostError> {
    let totals = sqlx::query(
        "SELECT scope_type,scope_id,spend_cents FROM cost_monthly_spend_rollups
         WHERE org_id=$1::uuid AND month_start=date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           AND ((scope_type='organization' AND scope_id=$1::text)
             OR (scope_type='agent' AND scope_id=$2::text))",
    )
    .bind(&run.organization_id)
    .bind(&run.agent_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut agent_total = None;
    let mut org_total = None;
    for row in totals {
        let scope_type: String = row.try_get("scope_type")?;
        let scope_id: String = row.try_get("scope_id")?;
        let total: i32 = row.try_get("spend_cents")?;
        if scope_type == "agent" && scope_id == run.agent_id {
            agent_total = Some(total);
        } else if scope_type == "organization" && scope_id == run.organization_id {
            org_total = Some(total);
        }
    }
    let (Some(agent_total), Some(org_total)) = (agent_total, org_total) else {
        return Err(GoalCostError::InvalidReceipt);
    };
    sqlx::query("UPDATE agents SET spent_monthly_cents=$3,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&run.organization_id)
        .bind(&run.agent_id)
        .bind(agent_total)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE organizations SET spent_monthly_cents=$2,updated_at=statement_timestamp() WHERE id=$1::uuid")
        .bind(&run.organization_id)
        .bind(org_total)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn update_agent_runtime_state(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
    ledger: &LedgerReceipt,
    inserted_event: bool,
) -> Result<(), GoalCostError> {
    let prompt_tokens = if ledger.provider.trim().eq_ignore_ascii_case("anthropic")
        || ledger.provider.trim().eq_ignore_ascii_case("claude")
    {
        i64::from(ledger.input_tokens).saturating_add(i64::from(ledger.cached_input_tokens))
    } else {
        i64::from(ledger.input_tokens)
    };
    let add_cost = if inserted_event {
        i64::from(ledger.cost_cents)
    } else {
        0
    };
    let add_input = if inserted_event { prompt_tokens } else { 0 };
    let add_cached = if inserted_event {
        i64::from(ledger.cached_input_tokens)
    } else {
        0
    };
    let add_output = if inserted_event {
        i64::from(ledger.output_tokens)
    } else {
        0
    };
    let session_id = run.result.get("sessionId").and_then(Value::as_str);
    let latest_terminal_error = run.error.as_deref();
    sqlx::query(
        "INSERT INTO agent_runtime_state AS current
           (agent_id,org_id,agent_runtime_type,session_id,last_run_id,last_run_status,
            total_input_tokens,total_output_tokens,total_cached_input_tokens,total_cost_cents,
            last_error,created_at,updated_at)
         SELECT a.id,a.org_id,a.agent_runtime_type,$3,$4::uuid,$5,$6,$7,$8,$9,$10,
                statement_timestamp(),statement_timestamp()
         FROM agents a WHERE a.org_id=$1::uuid AND a.id=$2::uuid
         ON CONFLICT (agent_id) DO UPDATE SET
           agent_runtime_type=EXCLUDED.agent_runtime_type,
           session_id=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.session_id ELSE current.session_id END,
           last_run_status=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.last_run_status ELSE current.last_run_status END,
           last_error=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.last_error ELSE current.last_error END,
           last_run_id=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.last_run_id ELSE current.last_run_id END,
           total_input_tokens=current.total_input_tokens+EXCLUDED.total_input_tokens,
           total_output_tokens=current.total_output_tokens+EXCLUDED.total_output_tokens,
           total_cached_input_tokens=current.total_cached_input_tokens+EXCLUDED.total_cached_input_tokens,
           total_cost_cents=current.total_cost_cents+EXCLUDED.total_cost_cents,
           updated_at=statement_timestamp()",
    )
    .bind(&run.organization_id)
    .bind(&run.agent_id)
    .bind(session_id)
    .bind(&run.run_id)
    .bind(&run.status)
    .bind(add_input)
    .bind(add_output)
    .bind(add_cached)
    .bind(add_cost)
    .bind(latest_terminal_error)
    .execute(&mut **tx)
    .await?;
    Ok(())
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
